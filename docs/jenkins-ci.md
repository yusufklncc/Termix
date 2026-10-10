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

| Stage   | When                 | What                                                                                                                   |
| ------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Checks  | every branch and tag | `npm ci`, `build:sdk`, `lint`, `prettier --check`, `type-check`, `build`, `test`, `test:plugins`                       |
| Publish | release tags only    | builds the image, validates nginx inside it, pushes to the GitLab registry (and Docker Hub while that is still wanted) |

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

1. **Job type:** Multibranch Pipeline, pointed at
   `https://gitlab.fatihk.tr/yusufihsankilinc/termix.git`.

2. **Branch sources:** add _Discover branches_ and _Discover tags_. Give the tag discovery a name
   filter of `v*`, `netmgr-v*`, `bridge-v*` — without one, the first scan queues a build for each
   of upstream's 48 tags. They would all pass (the Publish stage skips them), but the queue is an
   hour of nothing.

3. **Credentials** (Jenkins → Credentials, kind _Username with password_):

   | ID                       | Username               | Password                                                   |
   | ------------------------ | ---------------------- | ---------------------------------------------------------- |
   | `termix-gitlab`          | `oauth2`               | a GitLab token with `read_repository` — used to clone      |
   | `termix-gitlab-registry` | `oauth2`               | a GitLab token with `write_registry` — used to push images |
   | `termix-dockerhub`       | the Docker Hub account | a Docker Hub access token                                  |

   The registry one needs write access; a deploy token scoped to `read_registry`, which is what the
   server uses, cannot push. Drop `termix-dockerhub` and set the `PUBLISH_DOCKER_HUB` parameter to
   false once the server pulls from GitLab and Docker Hub is retired.

4. **Agents:** the Checks stage runs inside a `node:24` container (the version in `.nvmrc`, which is
   what upstream's CI validates against), so the agent needs Docker and the Docker Pipeline plugin,
   not a Node installation. The Publish stage runs on the agent itself and needs the Docker CLI and
   a daemon.

5. **Webhook:** GitLab → Settings → Webhooks, with _Push events_ and _Tag push events_, pointed at
   `/multibranch-webhook-trigger/invoke?token=<token>` (or the GitLab plugin's endpoint, depending
   on which is installed). The project's own GitLab CI/CD feature is disabled — Jenkins is the CI
   here — and that setting does not affect webhooks.

   **Jenkins sits behind Pangolin**, which authenticates every request: `jenkins.fatihk.tr` answers
   401 even on `/login`. A webhook sent to that hostname hits the sign-in wall, not Jenkins, so one
   of these has to be arranged:

   - **Point the webhook past the proxy** — GitLab and Jenkins run on the same host, so GitLab can
     reach Jenkins on the internal address they share (a container name, or the host's own port).
     Jenkins' port is not published on the LAN address, so this depends on the two sharing a Docker
     network. Preferred: the trigger never leaves the machine and is never exposed.
   - **A Pangolin rule** that lets the webhook path through unauthenticated, ideally narrowed to
     GitLab's address. The trigger token in the URL is then the only thing guarding it.
   - **Polling** as a fallback: Jenkins checks GitLab on a schedule. No network arrangement, but
     delayed builds and a steady trickle of pointless fetches.

## Not covered yet

`pr-check.yml` has a second job that runs the repository suite against real PostgreSQL and MySQL
servers (`npm run verify:dialect` plus `src/backend/tests/database/repositories`). The test suite
otherwise only ever sees SQLite, so every dialect difference — the RETURNING replacements, the
read-then-write transactions, the migrations themselves — is covered only there. That job has no
equivalent here yet; it needs two service containers alongside the build, and it should be added
once the pipeline above is known to run.
