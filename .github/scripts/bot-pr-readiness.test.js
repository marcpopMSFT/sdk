const assert = require("node:assert/strict");
const {test} = require("node:test");

const evaluateBotPullRequests = require("./bot-pr-readiness.js");

const MAESTRO = "dotnet-maestro[bot]";
const ACTIONS = "github-actions[bot]";
const ONELOC = "dotnet-oneloc-localization[bot]";
const HEAD_SHA = "a".repeat(40);
const context = {repo: {owner: "dotnet", repo: "sdk"}};

function commit(sha, author, committer = author, verified = false)
{
    return {sha: sha.padEnd(40, "0"), author: {login: author}, committer: {login: committer}, commit: {verification: {verified}}};
}

function createPr(number, overrides = {})
{
    return {
        number,
        html_url: `https://github.com/dotnet/sdk/pull/${number}`,
        state: "open",
        draft: false,
        mergeable: true,
        commits: 1,
        title: "[main] Update dependencies from dotnet/arcade",
        user: {login: MAESTRO},
        labels: [],
        base: {ref: "main", repo: {full_name: "dotnet/sdk"}},
        head: {ref: "darc-main-1234", sha: HEAD_SHA, repo: {full_name: "dotnet/sdk"}},
        ...overrides,
    };
}

function createGitHub({prs, commits = {}, files = {}, comparisons = {}})
{
    const successfulBuildAnalysis = [{app: {id: 216604}, head_sha: HEAD_SHA, status: "completed", conclusion: "success", started_at: "2026-11-16T00:00:00Z", html_url: "https://example.test/ba"}];
    const routes = {
        "GET /repos/{owner}/{repo}/pulls": () => prs,
        "GET /repos/{owner}/{repo}/pulls/{pull_number}": ({pull_number}) => prs.find((pr) => pr.number === pull_number),
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits": ({pull_number}) => commits[pull_number] ?? [],
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/files": ({pull_number}) => files[pull_number] ?? [],
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews": () => [],
        "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline": () => [],
        "GET /repos/{owner}/{repo}/commits/{ref}/check-runs": () => ({check_runs: successfulBuildAnalysis}),
    };

    function resolve(route, params)
    {
        if (route.includes("/compare/"))
        {
            const comparison = comparisons[route.split("/compare/")[1]];
            assert.ok(comparison, `Unexpected comparison ${route}`);
            return comparison;
        }

        assert.ok(routes[route], `Unexpected route ${route}`);
        const data = routes[route](params);
        if (data === undefined)
        {
            throw new Error("Not Found");
        }

        return data;
    }

    return {
        request: async (route, params) => ({data: resolve(route, params)}),
        paginate: async (route, params) => resolve(route, params),
    };
}

function createCore()
{
    const outputs = {};
    return {
        outputs,
        setOutput: (name, value) => outputs[name] = value,
        info() {},
        warning() {},
        setFailed: (message) => assert.fail(message),
    };
}

async function run(github, requestedPullRequestNumber)
{
    const core = createCore();
    const actions = await evaluateBotPullRequests({github, context, core, requestedPullRequestNumber});
    return {actions, outputs: core.outputs};
}

test("labels a codeflow PR whose commits are all from maestro and Build Analysis passed", async () =>
{
    const github = createGitHub({prs: [createPr(1)], commits: {1: [commit("c1", MAESTRO)]}});

    const {actions, outputs} = await run(github);

    assert.deepEqual(actions.map(({action, number}) => ({action, number})), [{action: "add", number: 1}]);
    assert.equal(outputs.has_candidates, "true");
    assert.equal(outputs.add_numbers, "1");
});

test("removes the label when a human pushed to a codeflow PR", async () =>
{
    const pr = createPr(2, {labels: [{name: "ready-for-approval"}], commits: 2});
    const github = createGitHub({prs: [pr], commits: {2: [commit("c1", MAESTRO), commit("c2", "someone")]}});

    const {actions, outputs} = await run(github);

    assert.equal(actions[0].action, "remove");
    assert.match(actions[0].reasons.join(" "), /1 of 2 commits are not from the expected bot identity: c2.*someone/);
    assert.equal(outputs.remove_numbers, "2");
});



test("labels an inter-branch merge that only adds merge-bot commits on top of the source branch", async () =>
{
    const pr = createPr(5, {
        title: "[automated] Merge branch 'release/11.0.2xx' => 'main'",
        user: {login: ACTIONS},
        commits: 71,
        head: {ref: "merge/release/11.0.2xx-to-main", sha: HEAD_SHA, repo: {full_name: "dotnet/sdk"}},
    });
    const github = createGitHub({
        prs: [pr],
        comparisons: {[`release/11.0.2xx...${HEAD_SHA}`]: {ahead_by: 1, commits: [commit("reset", ACTIONS)]}},
    });

    const {actions} = await run(github);

    assert.equal(actions[0].action, "add");
    assert.equal(actions[0].commitCount, 1);
});

test("rejects inter-branch merges with human conflict resolutions", async () =>
{
    const pr = createPr(6, {
        title: "[automated] Merge branch 'release/11.0.2xx' => 'main'",
        user: {login: ACTIONS},
        labels: [{name: "ready-for-approval"}],
        head: {ref: "merge/release/11.0.2xx-to-main", sha: HEAD_SHA, repo: {full_name: "dotnet/sdk"}},
    });
    const github = createGitHub({
        prs: [pr],
        comparisons: {[`release/11.0.2xx...${HEAD_SHA}`]: {ahead_by: 2, commits: [commit("reset", ACTIONS), commit("fix", "someone")]}},
    });

    const {actions} = await run(github);

    assert.equal(actions[0].action, "remove");
    assert.match(actions[0].reasons[0], /commits added on top of `release\/11.0.2xx` are not from the expected bot identity/);
});

test("requires verified bot commits that only change xlf files for loc PRs", async () =>
{
    const loc = {
        title: "Localized file check-in by OneLocBuild Task: Build definition ID 140: Build ID 1",
        user: {login: ONELOC},
        head: {ref: "locfiles/1234", sha: HEAD_SHA, repo: {full_name: "dotnet/sdk"}},
    };
    const github = createGitHub({
        prs: [createPr(7, loc), createPr(8, loc)],
        commits: {7: [commit("c1", ONELOC, "web-flow", true)], 8: [commit("c1", ONELOC, "web-flow", true)]},
        files: {7: [{filename: "src/xlf/Strings.de.xlf"}], 8: [{filename: "src/xlf/Strings.de.xlf"}, {filename: "src/Program.cs"}]},
    });

    const {actions} = await run(github);

    assert.deepEqual(actions.map(({action, number}) => ({action, number})), [{action: "add", number: 7}]);
});

test("removes the label from any labeled PR that is not an eligible bot PR", async () =>
{
    const github = createGitHub({prs: [createPr(9, {user: {login: "someone"}, labels: [{name: "ready-for-approval"}]})]});

    const {actions} = await run(github);

    assert.equal(actions[0].action, "remove");
});

