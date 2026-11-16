// Deterministic readiness evaluation for bot-authored PRs.
// See .github/workflows/bot-pr-readiness.md for the policy this implements.

const READY_LABEL = "ready-for-approval";
const BUILD_ANALYSIS_CHECK_NAME = "Build Analysis";
const BUILD_ANALYSIS_APP_ID = 216604;
const PAGE_SIZE = 100;
// GitHub's pull-request commits and compare APIs return at most 250 commits.
const MAX_LISTED_COMMITS = 250;
const MAX_ACTIONS = 20;
const MAX_REPORTED_COMMITS = 5;
const MAX_EVIDENCE_COMMITS = 20;
const SAFE_BRANCH_PATTERN = /^[A-Za-z0-9._\/-]+$/;
const ELIGIBLE_BASE_PATTERN = /^(main|release\/.+)$/;
const GITHUB_ACTIONS_BOT = "github-actions[bot]";
const WEB_FLOW = "web-flow";

const PR_TYPES = [
    {
        id: "codeflow",
        description: "darc codeflow / dependency update",
        author: "dotnet-maestro[bot]",
        headPattern: /^darc-/,
        titlePattern: /\b(Update dependencies from|Source code updates from) /,
    },
    {
        id: "loc",
        description: "OneLocBuild localization check-in",
        author: "dotnet-oneloc-localization[bot]",
        headPattern: /^locfiles\//,
        titlePattern: /^Localized file check-in by OneLocBuild Task/,
    },
    {
        id: "inter-branch",
        description: "inter-branch merge",
        author: GITHUB_ACTIONS_BOT,
        headPattern: /^merge\//,
        titlePattern: /^\[automated\] Merge branch '(?<source>[^']+)' => '(?<target>[^']+)'$/,
    },
];

function matchPrType(pr)
{
    return PR_TYPES.find((type) =>
        pr.user?.login === type.author &&
        type.headPattern.test(pr.head?.ref ?? "") &&
        type.titlePattern.test(pr.title ?? "")) ?? null;
}

function hasReadyLabel(pr)
{
    return (pr.labels ?? []).some((label) => (typeof label === "string" ? label : label.name) === READY_LABEL);
}

function describeCommit(commit)
{
    return {
        sha: commit.sha,
        author: commit.author?.login ?? null,
        committer: commit.committer?.login ?? null,
        verified: commit.commit?.verification?.verified === true,
    };
}

function checkCommitIdentities(commits, isAllowed, label)
{
    const offending = commits.filter((commit) => !isAllowed(commit));
    if (offending.length === 0)
    {
        return [];
    }

    const examples = offending.slice(0, MAX_REPORTED_COMMITS)
        .map((commit) => `${commit.sha.slice(0, 12)} (author \`${commit.author ?? "unknown"}\`, committer \`${commit.committer ?? "unknown"}\`)`);
    const more = offending.length > examples.length ? `, and ${offending.length - examples.length} more` : "";
    return [`${offending.length} of ${commits.length} ${label} not from the expected bot identity: ${examples.join(", ")}${more}.`];
}

async function getBuildAnalysis(github, owner, repo, headSha)
{
    const {data} = await github.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
        owner,
        repo,
        ref: headSha,
        check_name: BUILD_ANALYSIS_CHECK_NAME,
        per_page: PAGE_SIZE,
    });
    const runs = (data.check_runs ?? [])
        .filter((run) => run.app?.id === BUILD_ANALYSIS_APP_ID && run.head_sha === headSha)
        .sort((left, right) => Date.parse(right.started_at ?? 0) - Date.parse(left.started_at ?? 0));
    const latest = runs[0];
    return latest
        ? {status: latest.status, conclusion: latest.conclusion, url: latest.html_url}
        : {status: "missing", conclusion: null, url: null};
}

async function getChangesRequestedReviewers(github, owner, repo, number)
{
    const reviews = await github.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
        owner,
        repo,
        pull_number: number,
        per_page: PAGE_SIZE,
    });
    const latestByReviewer = new Map();
    for (const review of reviews)
    {
        if (!review.user?.login || review.state === "COMMENTED" || review.state === "PENDING")
        {
            continue;
        }

        latestByReviewer.set(review.user.login, review.state);
    }

    return [...latestByReviewer].filter(([, state]) => state === "CHANGES_REQUESTED").map(([login]) => login);
}

async function getForeignForcePushActors(github, owner, repo, number, expectedActor)
{
    const events = await github.paginate("GET /repos/{owner}/{repo}/issues/{issue_number}/timeline", {
        owner,
        repo,
        issue_number: number,
        per_page: PAGE_SIZE,
    });
    return [...new Set(events
        .filter((event) => event.event === "head_ref_force_pushed" && event.actor?.login !== expectedActor)
        .map((event) => event.actor?.login ?? "unknown"))];
}

async function checkCodeflowCommits(github, owner, repo, pr, type)
{
    const commits = (await github.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", {
        owner,
        repo,
        pull_number: pr.number,
        per_page: PAGE_SIZE,
    })).map(describeCommit);
    const failures = checkCommitIdentities(
        commits,
        (commit) => commit.author === type.author && commit.committer === type.author,
        "commits are");
    return {commits, failures};
}

async function checkLocCommits(github, owner, repo, pr, type)
{
    const commits = (await github.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", {
        owner,
        repo,
        pull_number: pr.number,
        per_page: PAGE_SIZE,
    })).map(describeCommit);
    const failures = checkCommitIdentities(
        commits,
        (commit) => commit.author === type.author && commit.committer === WEB_FLOW && commit.verified,
        "commits are");

    const files = await github.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
        owner,
        repo,
        pull_number: pr.number,
        per_page: PAGE_SIZE,
    });
    const nonXlf = files.map((file) => file.filename).filter((filename) => !filename.endsWith(".xlf"));
    if (nonXlf.length > 0)
    {
        failures.push(`${nonXlf.length} changed file(s) are not \`.xlf\` localization files.`);
    }

    return {commits, failures};
}

async function checkInterBranchCommits(github, owner, repo, pr, type)
{
    const {source, target} = pr.title.match(type.titlePattern).groups;
    const failures = [];
    if (target !== pr.base.ref)
    {
        failures.push(`Title target \`${target}\` does not match base branch \`${pr.base.ref}\`.`);
    }

    if (pr.head.ref !== `merge/${source}-to-${target}`)
    {
        failures.push(`Head branch \`${pr.head.ref}\` does not match \`merge/${source}-to-${target}\`.`);
    }

    if (!SAFE_BRANCH_PATTERN.test(source))
    {
        failures.push("Source branch name contains unsupported characters.");
        return {commits: [], failures, source};
    }

    // Commits reachable from the PR head but not from the source branch were added
    // on the merge branch itself. Only the merge bot's own commits (for example,
    // "Reset files to main") are allowed there; anything else is a human resolution.
    const {data: comparison} = await github.request(
        `GET /repos/{owner}/{repo}/compare/${source}...${pr.head.sha}`,
        {owner, repo, per_page: PAGE_SIZE});
    if (comparison.ahead_by > (comparison.commits ?? []).length)
    {
        failures.push(`The merge branch has ${comparison.ahead_by} commits not on \`${source}\`; too many to verify.`);
    }

    const commits = (comparison.commits ?? []).map(describeCommit);
    failures.push(...checkCommitIdentities(
        commits,
        (commit) => commit.author === GITHUB_ACTIONS_BOT && commit.committer === GITHUB_ACTIONS_BOT,
        `commits added on top of \`${source}\` are`));
    return {commits, failures, source};
}

const COMMIT_CHECKERS = {
    "codeflow": checkCodeflowCommits,
    "loc": checkLocCommits,
    "inter-branch": checkInterBranchCommits,
};

async function evaluatePullRequest({github, owner, repo, number})
{
    const {data: pr} = await github.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo,
        pull_number: number,
    });
    const type = matchPrType(pr);
    const evaluation = {
        number: pr.number,
        url: pr.html_url,
        type: type?.id ?? null,
        typeDescription: type?.description ?? null,
        author: pr.user?.login ?? null,
        base: pr.base?.ref ?? null,
        headSha: pr.head?.sha ?? null,
        labeled: hasReadyLabel(pr),
        state: "not-ready",
        reasons: [],
        pending: [],
        commitCount: 0,
        commits: [],
        buildAnalysis: null,
    };

    if (pr.state !== "open")
    {
        evaluation.reasons.push("PR is not open.");
        return evaluation;
    }

    if (!type)
    {
        evaluation.reasons.push("PR does not match an eligible bot PR type (author, head branch, and title).");
        return evaluation;
    }

    if (pr.draft)
    {
        evaluation.reasons.push("PR is a draft.");
    }

    if (!ELIGIBLE_BASE_PATTERN.test(pr.base.ref))
    {
        evaluation.reasons.push(`Base branch \`${pr.base.ref}\` is not \`main\` or \`release/*\`.`);
    }

    if (pr.head.repo?.full_name !== pr.base.repo?.full_name)
    {
        evaluation.reasons.push("Head branch is not in this repository.");
    }

    if (pr.mergeable === false)
    {
        evaluation.reasons.push("PR has merge conflicts.");
    }
    else if (pr.mergeable !== true)
    {
        evaluation.pending.push("GitHub has not finished computing mergeability.");
    }

    if (pr.commits > MAX_LISTED_COMMITS && type.id !== "inter-branch")
    {
        evaluation.reasons.push(`PR has ${pr.commits} commits; GitHub only lists ${MAX_LISTED_COMMITS}, so they cannot all be verified.`);
    }
    else
    {
        const {commits, failures} = await COMMIT_CHECKERS[type.id](github, owner, repo, pr, type);
        evaluation.commitCount = commits.length;
        evaluation.commits = commits.slice(0, MAX_EVIDENCE_COMMITS);
        evaluation.reasons.push(...failures);
    }

    const forcePushActors = await getForeignForcePushActors(github, owner, repo, pr.number, type.author);
    if (forcePushActors.length > 0)
    {
        evaluation.reasons.push(`Head branch was force-pushed by ${forcePushActors.map((login) => `\`${login}\``).join(", ")}.`);
    }

    const changesRequested = await getChangesRequestedReviewers(github, owner, repo, pr.number);
    if (changesRequested.length > 0)
    {
        evaluation.reasons.push(`Changes requested by ${changesRequested.map((login) => `\`${login}\``).join(", ")}.`);
    }

    evaluation.buildAnalysis = await getBuildAnalysis(github, owner, repo, pr.head.sha);
    if (evaluation.buildAnalysis.conclusion !== "success")
    {
        const {status, conclusion} = evaluation.buildAnalysis;
        evaluation.reasons.push(`\`${BUILD_ANALYSIS_CHECK_NAME}\` on ${pr.head.sha.slice(0, 12)} is ${conclusion ?? status}, not success.`);
    }

    if (evaluation.reasons.length === 0)
    {
        evaluation.state = evaluation.pending.length === 0 ? "ready" : "unknown";
    }

    return evaluation;
}

function decideAction(evaluation)
{
    if (evaluation.state === "ready" && !evaluation.labeled)
    {
        return "add";
    }

    if (evaluation.state === "not-ready" && evaluation.labeled)
    {
        return "remove";
    }

    return null;
}

function parsePullRequestNumber(value)
{
    const text = String(value ?? "").trim();
    if (!text)
    {
        return null;
    }

    if (!/^[1-9]\d*$/.test(text))
    {
        throw new Error(`Invalid PR number: ${text}`);
    }

    return Number(text);
}

async function findPullRequestNumbers({github, owner, repo})
{
    const openPrs = await github.paginate("GET /repos/{owner}/{repo}/pulls", {
        owner,
        repo,
        state: "open",
        per_page: PAGE_SIZE,
    });
    // Every labeled PR is re-evaluated so the label cannot persist on a PR that fails the rules,
    // regardless of who or what applied it.
    return openPrs
        .filter((pr) => matchPrType(pr) || hasReadyLabel(pr))
        .map((pr) => pr.number);
}

function setOutputs(core, actions)
{
    const adds = actions.filter((item) => item.action === "add").map((item) => item.number);
    const removes = actions.filter((item) => item.action === "remove").map((item) => item.number);
    core.setOutput("has_candidates", actions.length > 0 ? "true" : "false");
    core.setOutput("candidate_count", String(actions.length));
    core.setOutput("add_numbers", adds.join(","));
    core.setOutput("remove_numbers", removes.join(","));
    core.setOutput("evaluations", JSON.stringify(actions, null, 2));
}

module.exports = async function evaluateBotPullRequests({github, context, core, requestedPullRequestNumber})
{
    const {owner, repo} = context.repo;
    let numbers;
    try
    {
        const requested = parsePullRequestNumber(requestedPullRequestNumber);
        numbers = requested ? [requested] : await findPullRequestNumbers({github, owner, repo});
    }
    catch (error)
    {
        core.setFailed(`Unable to select pull requests: ${error.message}`);
        setOutputs(core, []);
        return [];
    }

    core.info(`Evaluating ${numbers.length} pull request(s): ${numbers.join(", ") || "none"}`);
    const actions = [];
    for (const number of numbers)
    {
        let evaluation;
        try
        {
            evaluation = await evaluatePullRequest({github, owner, repo, number});
        }
        catch (error)
        {
            // Never change the label from incomplete data.
            core.warning(`#${number}: evaluation failed, leaving label unchanged: ${error.message}`);
            continue;
        }

        const action = decideAction(evaluation);
        core.info(`#${number}: ${evaluation.state}${action ? ` -> ${action} label` : ""}${evaluation.reasons.length ? ` (${evaluation.reasons.join(" ")})` : ""}`);
        if (action)
        {
            actions.push({action, ...evaluation});
        }
    }

    // Removals are safety-relevant, so they take priority over additions when capped.
    actions.sort((left, right) => (left.action === right.action ? 0 : left.action === "remove" ? -1 : 1));
    const selected = actions.slice(0, MAX_ACTIONS);
    if (actions.length > selected.length)
    {
        core.warning(`${actions.length - selected.length} label change(s) deferred to the next run.`);
    }

    setOutputs(core, selected);
    return selected;
};

module.exports.READY_LABEL = READY_LABEL;
module.exports.MAX_ACTIONS = MAX_ACTIONS;
module.exports.evaluatePullRequest = evaluatePullRequest;
module.exports.matchPrType = matchPrType;
