// Above the owner's decision: small blocks, the payment, meet the shield. Paid, they pass through it in green. Not paid,
// they strike it in orange and fall back. About a second, then still. With reduced motion it's a still picture.
import { motion, useReducedMotion } from "motion/react";
import { SHIELD_PATH } from "./WardyShield";

const WIDTH = 168;
const HEIGHT = 72;
const SHIELD_X = (WIDTH - 48) / 2;
const SHIELD_Y = (HEIGHT - 52) / 2;
// Rows and starting delays, fixed so every visit looks the same.
const BLOCKS = [
  { y: 24, delay: 0 },
  { y: 34, delay: 0.08 },
  { y: 44, delay: 0.16 },
  { y: 29, delay: 0.26 },
  { y: 39, delay: 0.34 },
  { y: 49, delay: 0.42 },
];

export function DecisionMark({ paid }: { paid: boolean }) {
  const reduced = useReducedMotion();
  const colour = paid ? "#3df2b0" : "#ff7a3d";
  const hit = SHIELD_X - 6;
  return (
    <svg className="decision-mark" width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={paid ? "The payment went through the shield" : "The shield stopped the payment"}>
      {BLOCKS.map(({ y, delay }) =>
        reduced ? (
          <rect key={y} x={paid ? WIDTH - 22 - delay * 30 : hit - 18 - delay * 30} y={y - 2.5} width="5" height="5" rx="1" fill={colour} opacity={0.8} />
        ) : paid ? (
          // Drawn before the shield, so they pass behind it: through, not around.
          <motion.rect
            key={y}
            y={y - 2.5}
            width="5"
            height="5"
            rx="1"
            fill={colour}
            initial={{ x: 0, opacity: 0 }}
            animate={{ x: [0, WIDTH - 5], opacity: [0, 1, 1, 0] }}
            transition={{ duration: 0.9, delay, ease: [0.4, 0, 0.2, 1], times: [0, 0.15, 0.85, 1] }}
          />
        ) : (
          <motion.rect
            key={y}
            y={y - 2.5}
            width="5"
            height="5"
            rx="1"
            fill={colour}
            initial={{ x: 0, opacity: 0 }}
            animate={{ x: [0, hit, hit - 14 - delay * 20], y: [0, 0, 10 + delay * 12], opacity: [0, 1, 0], rotate: [0, 0, 90] }}
            transition={{ duration: 0.8, delay, ease: "easeOut", times: [0, 0.55, 1] }}
          />
        ),
      )}
      <motion.g
        initial={false}
        animate={reduced ? {} : paid ? { y: [0, 2, 0] } : { scale: [1, 1, 0.9, 1.04, 1] }}
        transition={{ duration: paid ? 0.4 : 0.7, delay: paid ? 0.5 : 0.35, ease: "easeOut" }}
        style={{ transformBox: "fill-box", transformOrigin: "center" }}
      >
        <path d={SHIELD_PATH} transform={`translate(${SHIELD_X} ${SHIELD_Y})`} fill="#00F29B" stroke="#00F29B" strokeWidth="2" strokeLinejoin="round" />
        {[16.5, 31.5].map((cx) => (
          <rect key={cx} x={SHIELD_X + cx - 5.5} y={SHIELD_Y + 23 - (paid ? 1.9 : 0.8)} width="11" height={paid ? 3.8 : 1.6} rx="1" fill="#050809" />
        ))}
      </motion.g>
    </svg>
  );
}
