# Jenkins CI for this fork

Written for: whoever sets up or maintains the fork's own build, on the self-hosted Jenkins at
`jenkins.fatihk.tr`.

## Why there is one

Upstream's checks live in `.github/workflows/pr-check.yml` and run **on a pull request**. This fork
pushes straight to `main` and opens no pull requests, so before this pipeline existed nothing ran
lint, the type-check or the ~3,900 tests between a commit and a published image — it was done by
hand, and a release went out on the strength of someone remembering to.

The [`Jenkinsfile`](../Jenkinsfile) at the repository root runs that same job, in that same order,
on every push, and publishes images when a release tag appears.

## What it does

| Stage   | When                 | What                                                                                                      |
| ------- | -------------------- | --------------------------------------------------------------------------------------------------------- |
| Checks  | every branch and tag | `npm ci`, `build:sdk`, `lint`, `prettier --check`, `type-check`, `build`, `test`, `test:plugins`          |
| Publish | release tags only    | builds the image, validates nginx inside it, pushes to Harbor (and Docker Hub while that is still wanted) |

The order in Checks is not arbitrary: `build:sdk` has to come before anything else, because the
core and every plugin type-check against the SDK's built output. `npm run lint` rather than
`npx eslint`, because the script also checks that the generated dialect schemas still match
`schema.ts`.

## Release tags

Publishing hangs off a tag, never a branch, so a push to `main` can fail its checks without moving
an image that someone is running.

| Tag                   | Publishes             |
| --------------------- | --------------------- |
| `v2.9.2-rdp.12`       | the application image |
| `netmgr-v2.9.2-rdp.5` | the VPN manager       |
| `bridge-v2.8.0-rdp.2` | the FreeRDP bridge    |

Anything else — including upstream's own 48 `release-*-tag` tags, which this repository carries —
skips the Publish stage rather than failing it.

```bash
git tag v2.9.2-rdp.12
git push origin v2.9.2-rdp.12
```

## Setting it up

1. **Job type:** Multibranch Pipeline with a **GitLab Project** branch source, which also reports
   each build's result back to the commit in GitLab. The GitLab server is configured once under
   Manage Jenkins → System → _GitLab Servers_ (the Branch Source plugin's own section — not
   _GitLab connections_, which belongs to the older GitLab plugin and may be in use by other jobs
   on this shared Jenkins).

   Its **Server URL must be `http://gitlab`**, the container name on the shared Docker network.
   Jenkins cannot reach `gitlab.fatihk.tr`; the first indexing attempt failed on exactly that. Its
   credential is a GitLab personal access token with `api`, which the plugin uses for metadata and
   for build status.

   **Checkout Credentials: `- anonymous -`.** The project is public, so cloning needs no token at
   all — one fewer secret to mint, store and renew. Making the project private later breaks the
   clone, and this is the line to come back to.

2. **Branch sources:** add _Discover branches_ and _Discover tags_. Give the tag discovery a name
   filter of `v*`, `netmgr-v*`, `bridge-v*` — without one, the first scan queues a build for each
   of upstream's 48 tags. They would all pass (the Publish stage skips them), but the queue is an
   hour of nothing.

   **The clone URL is GitLab's to choose, not Jenkins'.** The API answers with `http_url_to_repo`,
   built from GitLab's own `external_url`, so the checkout goes to `https://gitlab.fatihk.tr`
   however the server is addressed in Jenkins — and fails, because the agent cannot reach it.
   Indexing succeeds while checkout fails, which reads like a credentials problem and is not. The
   fix is to make that name resolvable from the containers rather than to fight the URL:

   ```yaml
   # jenkins and jenkins-agent services
   extra_hosts:
     - "gitlab.fatihk.tr:10.77.21.21"
   ```

3. **Credentials** (Jenkins → Credentials, kind _Username with password_):

   | ID                 | Username               | Password                                                                                              |
   | ------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------- |
   | `harbor-flab-push` | `robot$flab-jenkins`   | the push robot of Harbor's `flab` project — used to push images; shared with the other fork pipelines |
   | `termix-dockerhub` | the Docker Hub account | only if `PUBLISH_DOCKER_HUB` is turned on — it is off                                                 |

   There is deliberately no credential for cloning: the GitLab project is public, so the job's
   Branch Source leaves Credentials on `- none -` and no token has to be minted, stored or renewed
   for it. Making the project private later breaks the job, and this is the line to come back to.

   The registry one needs push access to the `flab` project; the project is public, so the server
   pulls without any login. Until 2026-10-16 the images went to the GitLab registry with a
   `termix-gitlab-registry` credential (a GitLab token with `write_registry`); that credential is
   no longer used. `PUBLISH_DOCKER_HUB` defaults to false: Harbor is the registry now, and
   Docker Hub was only the fallback while the server was being moved onto it. Turning the parameter
   on for a build requires `termix-dockerhub` to exist first, or the build fails looking for it.

4. **Agents:** the Checks stage runs inside a `node:24` container (the version in `.nvmrc`, which is
   what upstream's CI validates against), so the agent needs Docker and the Docker Pipeline plugin,
   not a Node installation. The Publish stage runs on the agent itself and needs the Docker CLI and
   a daemon.

   Checked on the live setup (2026-10-10): the `jenkins-agent` container has the Docker CLI and
   `/var/run/docker.sock`, and its `jenkins` user (uid 1000) is in the socket's group 991, so it can
   actually use it — a container that has the CLI but not the group looks fine until the first
   build. It has no Node, which is why the checks run in a container rather than on the agent.
   Jenkins itself publishes no port to the host; it is reachable only on the Docker network
   (`http://jenkins:8080`, or by address), and the Jenkinsfile was validated there through
   `/pipeline-model-converter/validate`.

5. **Webhook:** GitLab → Settings → Webhooks → `http://jenkins:8080/gitlab-webhook/post`, with
   _Push events_ and _Tag push events_. Added by hand, with the server's _Manage Web Hooks_ left
   off: the plugin would register one built from Jenkins' own root URL, and that points at
   `jenkins.fatihk.tr`.

   **Jenkins sits behind Pangolin**, which authenticates every request: `jenkins.fatihk.tr` answers
   401 even on `/login`, so a webhook sent there reaches a sign-in wall rather than Jenkins.
   `gitlab`, `jenkins` and `jenkins-agent` share the `devsecops` Docker network, so the internal
   address skips the proxy entirely and the trigger never leaves the machine.

   This endpoint takes an unauthenticated POST. The git plugin's `/git/notifyCommit` does not —
   since the fix for CVE-2022-36883 it answers 401 even with valid credentials, which is why it
   was not used. Jenkins' own root URL is left alone; other jobs on this shared instance depend on
   it.

   Keep the periodic scan as a long fallback (an hour is plenty) so a missed hook costs a delay
   rather than a build. The project's own GitLab CI/CD feature is disabled — Jenkins is the CI here
   — and that setting does not affect webhooks.

## Not covered yet

`pr-check.yml` has a second job that runs the repository suite against real PostgreSQL and MySQL
servers (`npm run verify:dialect` plus `src/backend/tests/database/repositories`). The test suite
otherwise only ever sees SQLite, so every dialect difference — the RETURNING replacements, the
read-then-write transactions, the migrations themselves — is covered only there. That job has no
equivalent here yet; it needs two service containers alongside the build, and it should be added
once the pipeline above is known to run.
