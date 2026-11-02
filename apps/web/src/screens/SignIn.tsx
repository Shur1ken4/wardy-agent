import { type FormEvent, useState } from "react";
import { ErrorNote, Page } from "../components/parts";
import { useDashboard } from "../lib/dashboard";

export function SignIn() {
  const { signIn, signInError, health } = useDashboard();
  const [value, setValue] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    signIn(value);
    setValue("");
  };
  return (
    <Page>
      <section className="card card-pad signin">
        <h1 className="section-title" style={{ font: "500 22px/1.2 var(--head)" }}>Owner sign-in</h1>
        <p className="note" style={{ marginTop: 8 }}>
          Your payment history and limits are private. Paste your owner credential to see them. It stays in this tab, and is gone when you close it.
        </p>
        <p className="note" style={{ marginTop: 8 }}>
          {health?.mode === "testnet" ? <>On testnet, it's <code>ownerToken</code> in <code>.data/testnet/secrets.json</code>.</> : <>It's <code>WARDY_OWNER_TOKEN</code> in your <code>.env</code>.</>}
        </p>
        <form onSubmit={submit}>
          <input className="input" type="password" autoComplete="off" aria-label="Owner credential" placeholder="Owner credential" value={value} onChange={(event) => setValue(event.target.value)} />
          <button type="submit" className="btn btn-primary" disabled={!value.trim()}>Sign in</button>
        </form>
        {signInError ? <ErrorNote>{signInError}</ErrorNote> : null}
      </section>
    </Page>
  );
}
