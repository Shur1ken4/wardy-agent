//! Wardy Network registry: anchors the Merkle root of the scam-payee report feed on NEAR.
//!
//! The reports themselves live in the off-chain feed. Anchoring their root here means anyone can check a
//! report was in the feed, and that the feed wasn't rewritten later. The contract stores no payee data and
//! makes no decisions. It holds only the latest root; earlier roots remain in the transaction history.

use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::store::IterableSet;
use near_sdk::{AccountId, BorshStorageKey, PanicOnDefault, env, log, near, require};

const MAX_URI_LEN: usize = 256;

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Reporters,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct AnchoredRoot {
    pub root: String,
    pub count: u32,
    pub uri: String,
    pub block_height: U64,
    pub reporter: AccountId,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    owner: AccountId,
    reporters: IterableSet<AccountId>,
    latest: Option<AnchoredRoot>,
}

/// A sha256 root as 64 lowercase hex characters, so one root has exactly one spelling.
fn is_root(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

#[near]
impl Registry {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            reporters: IterableSet::new(StorageKey::Reporters),
            latest: None,
        }
    }

    pub fn add_reporter(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.reporters.insert(account_id);
    }

    pub fn remove_reporter(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.reporters.remove(&account_id);
    }

    /// Records a new root. The feed is append-only, so `count` can never shrink, and the same `count` can
    /// only repeat the same root. A retry after a lost response is harmless; a rewritten feed is refused.
    pub fn anchor_root(&mut self, root: String, count: u32, uri: String) {
        let reporter = env::predecessor_account_id();
        require!(
            self.reporters.contains(&reporter),
            "Only a registered reporter can anchor a root"
        );
        require!(is_root(&root), "Root must be 64 lowercase hex characters");
        require!(count > 0, "Count must be above zero");
        require!(uri.len() <= MAX_URI_LEN, "URI is too long");
        if let Some(latest) = &self.latest {
            require!(
                count >= latest.count,
                "Count can't go down: the feed is append-only"
            );
            require!(
                count > latest.count || root == latest.root,
                "Same count needs the same root: the feed is append-only"
            );
        }

        let block_height = env::block_height();
        log!(
            "EVENT_JSON:{}",
            json!({
                "standard": "wardy-network",
                "version": "1.0.0",
                "event": "root_anchored",
                "data": [{ "root": root, "count": count, "uri": uri, "block_height": block_height.to_string(), "reporter": reporter }],
            })
        );
        self.latest = Some(AnchoredRoot {
            root,
            count,
            uri,
            block_height: block_height.into(),
            reporter,
        });
    }

    pub fn get_latest_root(&self) -> Option<AnchoredRoot> {
        self.latest.clone()
    }

    pub fn is_reporter(&self, account_id: AccountId) -> bool {
        self.reporters.contains(&account_id)
    }

    pub fn get_reporters(&self) -> Vec<AccountId> {
        self.reporters.iter().cloned().collect()
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "Only the owner can do this"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{VMContextBuilder, get_logs};
    use near_sdk::testing_env;

    fn account(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn act_as(name: &str, block_height: u64) {
        let mut context = VMContextBuilder::new();
        context
            .predecessor_account_id(account(name))
            .block_height(block_height);
        testing_env!(context.build());
    }

    fn root(fill: char) -> String {
        fill.to_string().repeat(64)
    }

    /// A registry owned by `owner.near`, with `reporter.near` registered, acting as `reporter.near`.
    fn registry() -> Registry {
        act_as("owner.near", 1);
        let mut registry = Registry::new(account("owner.near"));
        registry.add_reporter(account("reporter.near"));
        act_as("reporter.near", 10);
        registry
    }

    #[test]
    fn starts_empty_with_the_given_owner() {
        act_as("deployer.near", 1);
        let registry = Registry::new(account("owner.near"));
        assert_eq!(registry.get_owner(), account("owner.near"));
        assert_eq!(registry.get_latest_root(), None);
        assert!(registry.get_reporters().is_empty());
    }

    #[test]
    fn owner_adds_and_removes_reporters() {
        let mut registry = registry();
        assert!(registry.is_reporter(account("reporter.near")));
        assert_eq!(registry.get_reporters(), vec![account("reporter.near")]);

        act_as("owner.near", 11);
        registry.remove_reporter(account("reporter.near"));
        assert!(!registry.is_reporter(account("reporter.near")));
        assert!(registry.get_reporters().is_empty());
    }

    #[test]
    #[should_panic(expected = "Only the owner can do this")]
    fn stranger_cannot_add_a_reporter() {
        let mut registry = registry();
        act_as("attacker.near", 11);
        registry.add_reporter(account("attacker.near"));
    }

    #[test]
    #[should_panic(expected = "Only the owner can do this")]
    fn a_reporter_cannot_add_another_reporter() {
        let mut registry = registry();
        registry.add_reporter(account("friend.near"));
    }

    #[test]
    #[should_panic(expected = "Only the owner can do this")]
    fn stranger_cannot_remove_a_reporter() {
        let mut registry = registry();
        act_as("attacker.near", 11);
        registry.remove_reporter(account("reporter.near"));
    }

    #[test]
    fn reporter_anchors_a_root() {
        let mut registry = registry();
        registry.anchor_root(root('a'), 3, "https://feed.test/reports".to_string());
        assert_eq!(
            registry.get_latest_root(),
            Some(AnchoredRoot {
                root: root('a'),
                count: 3,
                uri: "https://feed.test/reports".to_string(),
                block_height: 10.into(),
                reporter: account("reporter.near"),
            })
        );
    }

    #[test]
    fn anchoring_logs_a_standard_event() {
        let mut registry = registry();
        registry.anchor_root(root('a'), 3, "u".to_string());
        let logs = get_logs();
        assert_eq!(logs.len(), 1);
        let event: near_sdk::serde_json::Value =
            near_sdk::serde_json::from_str(logs[0].strip_prefix("EVENT_JSON:").unwrap()).unwrap();
        assert_eq!(event["standard"], "wardy-network");
        assert_eq!(event["event"], "root_anchored");
        assert_eq!(event["data"][0]["count"], 3);
        assert_eq!(event["data"][0]["reporter"], "reporter.near");
    }

    #[test]
    #[should_panic(expected = "Only a registered reporter")]
    fn stranger_cannot_anchor() {
        let mut registry = registry();
        act_as("attacker.near", 11);
        registry.anchor_root(root('a'), 1, String::new());
    }

    #[test]
    #[should_panic(expected = "Only a registered reporter")]
    fn the_owner_is_not_automatically_a_reporter() {
        let mut registry = registry();
        act_as("owner.near", 11);
        registry.anchor_root(root('a'), 1, String::new());
    }

    #[test]
    #[should_panic(expected = "Only a registered reporter")]
    fn a_removed_reporter_cannot_anchor() {
        let mut registry = registry();
        act_as("owner.near", 11);
        registry.remove_reporter(account("reporter.near"));
        act_as("reporter.near", 12);
        registry.anchor_root(root('a'), 1, String::new());
    }

    #[test]
    #[should_panic(expected = "64 lowercase hex")]
    fn rejects_a_short_root() {
        registry().anchor_root("abc".to_string(), 1, String::new());
    }

    #[test]
    #[should_panic(expected = "64 lowercase hex")]
    fn rejects_an_uppercase_root() {
        registry().anchor_root("A".repeat(64), 1, String::new());
    }

    #[test]
    #[should_panic(expected = "64 lowercase hex")]
    fn rejects_a_non_hex_root() {
        registry().anchor_root("g".repeat(64), 1, String::new());
    }

    #[test]
    #[should_panic(expected = "Count must be above zero")]
    fn rejects_a_zero_count() {
        registry().anchor_root(root('a'), 0, String::new());
    }

    #[test]
    #[should_panic(expected = "URI is too long")]
    fn rejects_an_oversized_uri() {
        registry().anchor_root(root('a'), 1, "x".repeat(MAX_URI_LEN + 1));
    }

    #[test]
    fn accepts_a_uri_at_the_limit() {
        let mut registry = registry();
        registry.anchor_root(root('a'), 1, "x".repeat(MAX_URI_LEN));
        assert_eq!(registry.get_latest_root().unwrap().uri.len(), MAX_URI_LEN);
    }

    #[test]
    fn a_higher_count_replaces_the_latest_root() {
        let mut registry = registry();
        registry.anchor_root(root('a'), 1, String::new());
        act_as("reporter.near", 20);
        registry.anchor_root(root('b'), 2, String::new());
        let latest = registry.get_latest_root().unwrap();
        assert_eq!(
            (latest.root, latest.count, latest.block_height),
            (root('b'), 2, 20.into())
        );
    }

    #[test]
    fn repeating_the_same_root_and_count_is_harmless() {
        let mut registry = registry();
        registry.anchor_root(root('a'), 1, String::new());
        registry.anchor_root(root('a'), 1, String::new());
        assert_eq!(registry.get_latest_root().unwrap().count, 1);
    }

    #[test]
    #[should_panic(expected = "Count can't go down")]
    fn refuses_a_shrinking_feed() {
        let mut registry = registry();
        registry.anchor_root(root('a'), 5, String::new());
        registry.anchor_root(root('b'), 4, String::new());
    }

    #[test]
    #[should_panic(expected = "Same count needs the same root")]
    fn refuses_a_rewritten_feed() {
        let mut registry = registry();
        registry.anchor_root(root('a'), 5, String::new());
        registry.anchor_root(root('b'), 5, String::new());
    }
}
