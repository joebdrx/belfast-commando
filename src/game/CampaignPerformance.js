/**
 * CampaignPerformance
 * -------------------
 * Pure mission-result grading shared by the orchestrator, progression store,
 * sector-select UI, and tests. A clear always earns one medal; beating par and
 * rescuing every civilian are the two optional mastery medals.
 */

const RANKS = [
  { min: 92, rank: "S" },
  { min: 78, rank: "A" },
  { min: 64, rank: "B" },
  { min: 50, rank: "C" },
  { min: 0, rank: "D" },
];

const RANK_VALUE = { D: 0, C: 1, B: 2, A: 3, S: 4 };

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** Return a stable mission grade without mutating the result payload. */
export function evaluateSectorPerformance(result = {}, entry = {}) {
  const cleared = !result.died;
  const score = Math.max(0, Number(result.score) || 0);
  const time = Math.max(0, Number(result.time) || 0);
  const par = Math.max(1, Number(entry.par) || 45);
  const scoreTarget = Math.max(1, Number(entry.scoreTarget) || 5000);
  const civiliansSaved = Math.max(0, Number(result.civiliansSaved) || 0);
  const civiliansTotal = Math.max(0, Number(result.civiliansTotal) || 0);
  const allCivilians = civiliansTotal > 0 && civiliansSaved >= civiliansTotal;
  const underPar = cleared && time <= par;

  if (!cleared) {
    return { rank: "D", rating: 0, medals: 0, underPar: false, allCivilians: false };
  }

  const paceScore = clamp(par / Math.max(time, 1), 0, 1) * 25;
  const rescueRatio = civiliansTotal > 0 ? clamp(civiliansSaved / civiliansTotal, 0, 1) : 1;
  const rescueScore = rescueRatio * 20;
  const scoreScore = clamp(score / scoreTarget, 0, 1) * 15;
  const flawlessScore = result.noDamage ? 10 : 0;
  const rating = Math.round(30 + paceScore + rescueScore + scoreScore + flawlessScore);
  const rank = RANKS.find((candidate) => rating >= candidate.min).rank;
  const medals = 1 + Number(underPar) + Number(allCivilians);

  return { rank, rating, medals, underPar, allCivilians };
}

/** Merge one successful attempt into a persistent best-record snapshot. */
export function mergeSectorRecord(previous = null, attempt = {}) {
  if (attempt.died) return previous;
  const next = {
    clears: Math.max(0, Number(previous && previous.clears) || 0) + 1,
    bestScore: Math.max(Number(previous && previous.bestScore) || 0, Number(attempt.score) || 0),
    bestTime: Number(previous && previous.bestTime) || Infinity,
    bestRank: (previous && previous.bestRank) || "D",
    medals: Math.max(Number(previous && previous.medals) || 0, Number(attempt.medals) || 0),
  };
  const attemptTime = Number(attempt.time);
  if (Number.isFinite(attemptTime) && attemptTime >= 0) next.bestTime = Math.min(next.bestTime, attemptTime);
  if (!Number.isFinite(next.bestTime)) next.bestTime = 0;
  const attemptRank = attempt.rank in RANK_VALUE ? attempt.rank : "D";
  if (RANK_VALUE[attemptRank] > RANK_VALUE[next.bestRank]) next.bestRank = attemptRank;
  return next;
}

export function formatMissionTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const remainder = String(total % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}
