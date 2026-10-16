// What runs on every push to this fork's GitLab.
//
// Upstream's own checks only run on a pull request (.github/workflows/
// pr-check.yml) and this fork pushes straight to main, so until now nothing
// looked at a commit before it went into a release. The Checks stage is that
// workflow's lint-and-build job, step for step and in its order: the order is
// load-bearing, because everything after it type-checks against the plugin
// SDK's built output.
//
// Publishing hangs off a tag, never a branch. A push to main should be able
// to fail its checks without moving an image somebody is running.
//
// Tags that publish:
//   v2.9.2-rdp.12         -> the application image
//   netmgr-v2.9.2-rdp.5   -> the VPN manager
//   bridge-v2.8.0-rdp.2   -> the FreeRDP bridge
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
            // Matched here rather than inside, so that upstream's own tags --
            // the repository carries 48 of the release-2.9.2-tag kind -- skip
            // this stage instead of failing it.
            when {
                allOf {
                    buildingTag()
                    tag pattern: /^(netmgr-|bridge-)?v.+$/, comparator: 'REGEXP'
                }
            }
            agent any
            steps {
                script {
                    // Plain string work on purpose. A Groovy Matcher is not
                    // serializable, and this pipeline's CPS interpreter saves
                    // its state between steps -- a regex here fails the build
                    // with NotSerializableException rather than a bad tag.
                    String name = env.TAG_NAME
                    String component = 'app'
                    String version = null
                    if (name.startsWith('netmgr-v')) {
                        component = 'netmgr'
                        version = name.substring('netmgr-v'.length())
                    } else if (name.startsWith('bridge-v')) {
                        component = 'bridge'
                        version = name.substring('bridge-v'.length())
                    } else if (name.startsWith('v')) {
                        version = name.substring(1)
                    }
                    if (!version) {
                        error("tag ${name} does not name a release; expected v<tag>, netmgr-v<tag> or bridge-v<tag>")
                    }
                    env.TERMIX_COMPONENT = component
                    env.TERMIX_IMAGE_TAG = version
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
                sh '''
                    DOCKER_HUB=$([ "$PUBLISH_DOCKER_HUB" = "true" ] && echo 1 || echo 0) \
                      bash scripts/publish-fork-images.sh "$TERMIX_COMPONENT" "$TERMIX_IMAGE_TAG"
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
