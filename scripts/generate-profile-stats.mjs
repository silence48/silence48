import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const username = process.env.PROFILE_USERNAME || "silence48";
const token =
  process.env.PROFILE_STATS_TOKEN ||
  process.env.GH_TOKEN ||
  process.env.GITHUB_TOKEN;

if (!token) {
  throw new Error("Set GH_TOKEN or GITHUB_TOKEN before generating profile statistics.");
}

const now = process.env.PROFILE_STATS_NOW
  ? new Date(process.env.PROFILE_STATS_NOW)
  : new Date();

if (Number.isNaN(now.getTime())) {
  throw new Error("PROFILE_STATS_NOW must be a valid ISO-8601 timestamp.");
}

const from = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
const outputPath = path.resolve(
  process.env.PROFILE_STATS_OUTPUT || "assets/contribution-stats.svg",
);

const query = `
  query ProfileContributions($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              contributionCount
              date
            }
          }
        }
        restrictedContributionsCount
        totalCommitContributions
        totalIssueContributions
        totalPullRequestContributions
        totalPullRequestReviewContributions
        commitContributionsByRepository(maxRepositories: 100) {
          repository { owner { login } }
          contributions(first: 100) { totalCount }
        }
        issueContributionsByRepository(maxRepositories: 100) {
          repository { owner { login } }
          contributions(first: 100) { totalCount }
        }
        pullRequestContributionsByRepository(maxRepositories: 100) {
          repository { owner { login } }
          contributions(first: 100) { totalCount }
        }
        pullRequestReviewContributionsByRepository(maxRepositories: 100) {
          repository { owner { login } }
          contributions(first: 100) { totalCount }
        }
      }
    }
  }
`;

const response = await fetch("https://api.github.com/graphql", {
  method: "POST",
  headers: {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": `${username}-profile-stats`,
  },
  body: JSON.stringify({
    query,
    variables: {
      login: username,
      from: from.toISOString(),
      to: now.toISOString(),
    },
  }),
});

if (!response.ok) {
  throw new Error(`GitHub GraphQL request failed with HTTP ${response.status}.`);
}

const payload = await response.json();

if (payload.errors?.length) {
  throw new Error(
    `GitHub GraphQL request failed: ${payload.errors
      .map((error) => error.message)
      .join("; ")}`,
  );
}

const collection = payload.data?.user?.contributionsCollection;

if (!collection) {
  throw new Error(`GitHub did not return contribution data for ${username}.`);
}

const calendarDays = collection.contributionCalendar.weeks
  .flatMap((week) => week.contributionDays)
  .filter((day) => new Date(`${day.date}T00:00:00Z`) >= from);

const total = collection.contributionCalendar.totalContributions;
const privateTotal = collection.restrictedContributionsCount;
const publicTotal = Math.max(0, total - privateTotal);
const activeDays = calendarDays.filter((day) => day.contributionCount > 0).length;
const longestStreak = calculateLongestStreak(calendarDays);
const destinations = aggregatePublicDestinations(collection, username, publicTotal);

const svg = renderCard({
  activeDays,
  destinations,
  generatedDate: now.toISOString().slice(0, 10),
  issues: collection.totalIssueContributions,
  longestStreak,
  privateTotal,
  publicCommits: collection.totalCommitContributions,
  publicTotal,
  pullRequests: collection.totalPullRequestContributions,
  reviews: collection.totalPullRequestReviewContributions,
  total,
  username,
});

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, svg, "utf8");

console.log(
  `Generated ${path.relative(process.cwd(), outputPath)}: ${formatNumber(total)} total, ${formatNumber(privateTotal)} private, ${destinations.length} public destinations.`,
);

function aggregatePublicDestinations(data, login, publicContributionTotal) {
  const byOwner = new Map();
  const sources = [
    ["commits", data.commitContributionsByRepository],
    ["pullRequests", data.pullRequestContributionsByRepository],
    ["reviews", data.pullRequestReviewContributionsByRepository],
    ["issues", data.issueContributionsByRepository],
  ];

  for (const [kind, rows] of sources) {
    for (const row of rows) {
      const owner = row.repository.owner.login;
      const current = byOwner.get(owner) || {
        commits: 0,
        issues: 0,
        label:
          owner.toLowerCase() === login.toLowerCase()
            ? "Personal"
            : formatOwnerLabel(owner),
        pullRequests: 0,
        reviews: 0,
      };
      current[kind] += row.contributions.totalCount;
      byOwner.set(owner, current);
    }
  }

  const destinations = [...byOwner.values()].map((destination) => ({
    ...destination,
    total:
      destination.commits +
      destination.pullRequests +
      destination.reviews +
      destination.issues,
  }));
  const attributed = destinations.reduce((sum, destination) => sum + destination.total, 0);
  const unattributed = Math.max(0, publicContributionTotal - attributed);

  if (unattributed > 0) {
    destinations.push({
      commits: 0,
      issues: 0,
      label: "Other public activity",
      pullRequests: 0,
      reviews: 0,
      total: unattributed,
    });
  }

  destinations.sort((left, right) => right.total - left.total);

  if (destinations.length <= 6) {
    return destinations;
  }

  const visible = destinations.slice(0, 5);
  const remainder = destinations.slice(5).reduce(
    (combined, destination) => ({
      commits: combined.commits + destination.commits,
      issues: combined.issues + destination.issues,
      label: "Other public destinations",
      pullRequests: combined.pullRequests + destination.pullRequests,
      reviews: combined.reviews + destination.reviews,
      total: combined.total + destination.total,
    }),
    { commits: 0, issues: 0, pullRequests: 0, reviews: 0, total: 0 },
  );

  return [...visible, remainder];
}

function calculateLongestStreak(days) {
  let longest = 0;
  let current = 0;

  for (const day of days) {
    if (day.contributionCount > 0) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }

  return longest;
}

function renderCard(stats) {
  const ownerMax = Math.max(1, ...stats.destinations.map((destination) => destination.total));
  const publicRatio = stats.total === 0 ? 0 : stats.publicTotal / stats.total;
  const publicWidth = Math.round(344 * publicRatio);
  const destinationRows = stats.destinations
    .map((destination, index) => renderDestination(destination, index, ownerMax))
    .join("\n");
  const reviewLabel = [
    stats.pullRequests ? `${formatNumber(stats.pullRequests)} PR${stats.pullRequests === 1 ? "" : "s"}` : null,
    stats.reviews ? `${formatNumber(stats.reviews)} review${stats.reviews === 1 ? "" : "s"}` : null,
    stats.issues ? `${formatNumber(stats.issues)} issue${stats.issues === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ") || "No public PR activity";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="500" viewBox="0 0 1200 500" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(stats.username)} contribution pulse</title>
  <desc id="description">${formatNumber(stats.total)} GitHub contributions in the last twelve months, including ${formatNumber(stats.privateTotal)} private contributions. Public activity is grouped by repository owner without publishing private repository names.</desc>
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b0715" />
      <stop offset="0.55" stop-color="#21103d" />
      <stop offset="1" stop-color="#3b176f" />
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#8b5cf6" />
      <stop offset="1" stop-color="#d8b4fe" />
    </linearGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="28" />
    </filter>
    <style>
      text { font-family: Inter, Segoe UI, Arial, sans-serif; }
      .eyebrow { fill: #c4b5fd; font-size: 14px; font-weight: 700; letter-spacing: 2.4px; }
      .muted { fill: #a99fc0; font-size: 14px; }
      .metric { fill: #faf5ff; font-size: 23px; font-weight: 720; }
      .metric-label { fill: #b8afc9; font-size: 13px; }
      .owner { fill: #f5f3ff; font-size: 16px; font-weight: 650; }
      .owner-detail { fill: #aaa0bd; font-size: 12px; }
    </style>
  </defs>
  <rect width="1200" height="500" rx="24" fill="url(#background)" />
  <circle cx="1110" cy="24" r="210" fill="#7c3aed" fill-opacity="0.18" filter="url(#glow)" />
  <circle cx="62" cy="470" r="160" fill="#9333ea" fill-opacity="0.12" filter="url(#glow)" />
  <rect x="1" y="1" width="1198" height="498" rx="23" fill="none" stroke="#ddd6fe" stroke-opacity="0.15" stroke-width="2" />

  <text x="52" y="54" class="eyebrow">CONTRIBUTION PULSE · LAST 12 MONTHS</text>
  <text x="1148" y="54" text-anchor="end" class="muted">Updated ${escapeXml(stats.generatedDate)}</text>

  <rect x="52" y="84" width="410" height="354" rx="18" fill="#120a22" fill-opacity="0.72" stroke="#c4b5fd" stroke-opacity="0.12" />
  <text x="80" y="168" fill="#faf5ff" font-size="62" font-weight="760">${formatNumber(stats.total)}</text>
  <text x="82" y="197" fill="#c4b5fd" font-size="17">contributions across public and private work</text>

  ${renderMetric(80, 238, stats.privateTotal, "private contributions")}
  ${renderMetric(267, 238, stats.publicTotal, "public contributions")}
  ${renderMetric(80, 314, stats.activeDays, "active days")}
  ${renderMetric(267, 314, stats.longestStreak, "longest streak")}

  <rect x="80" y="382" width="344" height="9" rx="4.5" fill="#3c3150" />
  <rect x="80" y="382" width="${publicWidth}" height="9" rx="4.5" fill="url(#accent)" />
  <text x="80" y="415" class="owner-detail">${formatNumber(stats.publicCommits)} public commits · ${escapeXml(reviewLabel)}</text>

  <rect x="488" y="84" width="660" height="354" rx="18" fill="#120a22" fill-opacity="0.72" stroke="#c4b5fd" stroke-opacity="0.12" />
  <text x="520" y="121" class="eyebrow">PUBLIC ACTIVITY BY DESTINATION</text>
  ${destinationRows}

  <text x="52" y="474" class="muted">Generated in ${escapeXml(stats.username)}/${escapeXml(stats.username)} from GitHub's API · private repository names are never published</text>
</svg>
`;
}

function renderMetric(x, y, value, label) {
  return `<g transform="translate(${x} ${y})">
    <text class="metric">${formatNumber(value)}</text>
    <text y="23" class="metric-label">${escapeXml(label)}</text>
  </g>`;
}

function renderDestination(destination, index, maximum) {
  const y = 158 + index * 45;
  const barWidth = Math.max(
    8,
    Math.round((Math.log1p(destination.total) / Math.log1p(maximum)) * 300),
  );
  const details = [
    destination.commits ? pluralize(destination.commits, "commit") : null,
    destination.pullRequests ? pluralize(destination.pullRequests, "PR") : null,
    destination.reviews ? pluralize(destination.reviews, "review") : null,
    destination.issues ? pluralize(destination.issues, "issue") : null,
  ]
    .filter(Boolean)
    .join(" · ") || `${formatNumber(destination.total)} other contributions`;

  return `<g transform="translate(520 ${y})">
    <circle cx="10" cy="-5" r="10" fill="#8b5cf6" fill-opacity="${Math.max(0.32, 0.86 - index * 0.09).toFixed(2)}" />
    <text x="30" class="owner">${escapeXml(truncate(destination.label, 25))}</text>
    <text x="596" text-anchor="end" class="owner">${formatNumber(destination.total)}</text>
    <rect x="30" y="10" width="300" height="5" rx="2.5" fill="#3c3150" />
    <rect x="30" y="10" width="${barWidth}" height="5" rx="2.5" fill="url(#accent)" />
    <text x="348" y="15" class="owner-detail">${escapeXml(details)}</text>
  </g>`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatOwnerLabel(owner) {
  return owner
    .replaceAll(/[-_]+/g, " ")
    .replaceAll(/\b\p{L}/gu, (character) => character.toUpperCase());
}

function pluralize(value, noun) {
  return `${formatNumber(value)} ${noun}${value === 1 ? "" : "s"}`;
}

function truncate(value, length) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
