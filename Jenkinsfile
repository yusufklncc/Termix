// What runs on every push to this fork's GitLab.
//
// Upstream's own checks only run on a pull request (.github/workflows/
// pr-check.yml) and this fork pushes straight to main, so until now nothing
// looked at a commit before it went into a release. The Checks stage is that
// workflow's lint-and-build job, step for step and in its order: the order is
// load-bearing, because everything after it type-checks against the plugin
// SDK's built output.
//
// A push to main that passes the checks is a release, the way the other
// pipelines on this Jenkins publish; one that fails them publishes nothing.
// Every image of a release carries the same version, <upstream>-rdp.<build>:
// upstream's version from package.json, then this branch's build number,
// which only goes up. The application is published every time; the VPN
// manager and the FreeRDP bridge only when their directory changed.
//
// Until 2026-10-16 publishing hung off v*, netmgr-v* and bridge-v* tags,
// which Jenkins does not build on its own; a tag no longer publishes.
//
// Jenkins credentials this expects:
//   harbor-flab-push        username/password for harbor.fatihk.tr, the push
//                           robot of the flab project; the other fork
//                           pipelines push with the same one
//   termix-dockerhub        only when PUBLISH_DOCKER_HUB is turned on, which
//                           it is not by default

pipeline {
    agent none

    options {
        timestamps()
        // Two builds sharing a Docker build cache and a registry tag is not
        // worth the hour it would take to work out what went wrong.
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '30'))
        timeout(time: 90, unit: 'MINUTES')
    }

    parameters {
        booleanParam(
            name: 'PUBLISH_DOCKER_HUB',
            defaultValue: false,
            description: 'Also push to Docker Hub. Off: the registry is Harbor now, and Docker Hub was only the fallback while the server was moved onto it. Turning this on needs the termix-dockerhub credential to exist, or the build fails looking for it.'
        )
    }

    environment {
        // The plugin build and the test run both go past the default heap.
        NODE_OPTIONS = '--max-old-space-size=4096'
    }

    stages {
        stage('Checks') {
            agent {
                docker {
                    // .nvmrc, which is the version upstream's CI validates
                    // against. The release image pins its own node in
                    // docker/Dockerfile and is not affected by this.
                    image 'node:24'
                    // node-gyp wants a writable home, and the container runs
                    // as the agent's uid, not root. The npm cache is set per
                    // step instead, because it has to outlive the container.
                    args '-e HOME=/tmp'
                }
            }
            steps {
                /*
                 * The cache lives in the workspace, which survives between
                 * builds -- the container does not, so a cache inside it was
                 * thrown away every time and all 1198 packages came down the
                 * wire again. $WORKSPACE rather than a named volume: Docker
                 * creates a named volume owned by root and this container
                 * runs as the agent's uid, which would leave npm unable to
                 * write to the cache it was given.
                 */
                sh 'npm ci --cache "$WORKSPACE/.npm-cache"'
                // Nothing below compiles without this: the SDK's built output
                // is what the plugins and the core type-check against.
                sh 'npm run build:sdk'
                // npm run lint, not npx eslint -- the script also checks the
                // generated dialect schemas against schema.ts, which eslint
                // cannot see.
                sh 'npm run lint'
                sh 'npx prettier --check .'
                sh 'npm run type-check'
                sh 'npm run build'
                // A JUnit report as well as the console one. When a worker
                // dies mid-run the console says only that one file of 442
                // did not pass, without naming it; the XML names every test
                // that did run, so the missing one can be found by what is
                // absent from it.
                sh 'npm run test -- --reporter=default --reporter=junit --outputFile.junit=reports/core.xml'
                sh 'npm run test:plugins'
            }
            post {
                always {
                    archiveArtifacts artifacts: 'reports/*.xml', allowEmptyArchive: true, fingerprint: false
                }
            }
        }

        stage('Publish') {
            // Every other branch, merge request and tag stops after Checks.
            when { branch 'main' }
            agent any
            steps {
                script {
                    // The first "version" in package.json is the package's own.
                    String upstream = sh(
                        script: 'grep -m1 \'"version"\' package.json | cut -d\'"\' -f4',
                        returnStdout: true
                    ).trim()
                    if (!upstream) {
                        error('no version found in package.json')
                    }
                    env.TERMIX_IMAGE_TAG = "${upstream}-rdp.${env.BUILD_NUMBER}"
                }

                withCredentials([usernamePassword(
                    credentialsId: 'harbor-flab-push',
                    usernameVariable: 'REGISTRY_USER',
                    passwordVariable: 'REGISTRY_PASS'
                )]) {
                    sh 'echo "$REGISTRY_PASS" | docker login harbor.fatihk.tr -u "$REGISTRY_USER" --password-stdin'
                }

                script {
                    if (params.PUBLISH_DOCKER_HUB) {
                        withCredentials([usernamePassword(
                            credentialsId: 'termix-dockerhub',
                            usernameVariable: 'HUB_USER',
                            passwordVariable: 'HUB_PASS'
                        )]) {
                            sh 'echo "$HUB_PASS" | docker login -u "$HUB_USER" --password-stdin'
                        }
                    }
                }

                // The script does the rest: it refuses an uncommitted tree,
                // builds one manifest rather than an OCI index (GitLab's
                // registry rejected the index, and Harbor cannot scan the
                // build attestation an index carries), renders both nginx templates
                // inside the built image and runs nginx -t on them, and only
                // then pushes.
                //
                // The VPN manager and the bridge change rarely, and the bridge
                // builds FreeRDP from source. Each of their images is also
                // tagged src-<tree hash of its directory>; when Harbor already
                // has that tag, nothing in the directory changed and the build
                // is skipped. A first build, or one after a failed release,
                // finds no such tag and publishes.
                sh '''
                    export DOCKER_HUB=$([ "$PUBLISH_DOCKER_HUB" = "true" ] && echo 1 || echo 0)

                    bash scripts/publish-fork-images.sh app "$TERMIX_IMAGE_TAG"

                    publish_if_changed() {
                      component=$1 dir=$2 repo=$3
                      src="src-$(git rev-parse "HEAD:$dir" | cut -c1-12)"
                      code=$(curl -s -o /dev/null -w '%{http_code}' \
                        "https://harbor.fatihk.tr/api/v2.0/projects/flab/repositories/$repo/artifacts/$src")
                      case "$code" in
                        200) echo "==> $component: $dir unchanged ($src is in Harbor), not rebuilt" ;;
                        404) EXTRA_TAGS="$src" bash scripts/publish-fork-images.sh "$component" "$TERMIX_IMAGE_TAG" ;;
                        *) echo "Harbor answered $code looking for $component $src" >&2; return 1 ;;
                      esac
                    }
                    # The repository name is encoded twice in Harbor's API path.
                    publish_if_changed netmgr docker/net-manager termix%252Fnetmgr
                    publish_if_changed bridge docker/freerdp-bridge termix%252Frdp-bridge
                '''
            }
            post {
                always {
                    sh 'docker logout harbor.fatihk.tr || true'
                    sh 'docker logout || true'
                }
            }
        }
    }
}
