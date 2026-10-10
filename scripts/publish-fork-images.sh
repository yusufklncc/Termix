#!/usr/bin/env bash
# Builds and publishes this fork's images to the GitLab registry, and to
# Docker Hub while the move there is still in progress.
#
# The nginx config is rendered from a template at container start, so a
# config that does not parse only shows up as a restart loop on the server.
# It broke a live server once. So it is rendered and tested inside the built
# image here, before anything is pushed.
#
#   bash scripts/publish-fork-images.sh app 2.9.2-rdp.12
#   bash scripts/publish-fork-images.sh netmgr 2.9.2-rdp.5
#   bash scripts/publish-fork-images.sh bridge 2.8.0-rdp.2
#   DOCKER_HUB=0 bash scripts/publish-fork-images.sh app 2.9.2-rdp.12
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GITLAB_REGISTRY="${GITLAB_REGISTRY:-registry.fatihk.tr/yusufihsankilinc/termix}"
DOCKER_HUB_NS="${DOCKER_HUB_NS:-yusufklncc}"
# Set to 0 once the server pulls from GitLab and Docker Hub is retired.
DOCKER_HUB="${DOCKER_HUB:-1}"

component="${1:-}"
tag="${2:-}"
if [ -z "$component" ] || [ -z "$tag" ]; then
  echo "usage: $0 <app|netmgr|bridge> <tag>" >&2
  exit 64
fi

case "$component" in
  app)
    dockerfile="docker/Dockerfile"
    context="$ROOT"
    gitlab_image="$GITLAB_REGISTRY"
    hub_image="$DOCKER_HUB_NS/termix"
    ;;
  netmgr)
    dockerfile="docker/net-manager/Dockerfile"
    context="$ROOT/docker/net-manager"
    gitlab_image="$GITLAB_REGISTRY/netmgr"
    hub_image="$DOCKER_HUB_NS/termix-netmgr"
    ;;
  bridge)
    dockerfile="docker/freerdp-bridge/Dockerfile"
    context="$ROOT/docker/freerdp-bridge"
    gitlab_image="$GITLAB_REGISTRY/rdp-bridge"
    hub_image="$DOCKER_HUB_NS/termix-rdp-bridge"
    ;;
  *)
    echo "unknown component: $component" >&2
    exit 64
    ;;
esac

# A published image has to be one a commit can be found for. The tree gets
# built either way, so an uncommitted change would ship without anything
# recording what it was.
if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  echo "refusing to publish: the tree has uncommitted changes" >&2
  git -C "$ROOT" status --short >&2
  exit 1
fi
commit="$(git -C "$ROOT" rev-parse --short HEAD)"

local_tag="termix-publish-$component:$tag"
echo "==> building $component $tag from $commit"
# --provenance/--sbom off on purpose. With them on, buildx wraps the image
# in an OCI index alongside an attestation manifest, and `docker push`
# writes the index before the manifest it points at -- which the GitLab
# registry rejects with "blob unknown to registry", after uploading every
# layer. One plain manifest pushes to both registries.
docker build --provenance=false --sbom=false \
  -t "$local_tag" -f "$ROOT/$dockerfile" "$context"

if [ "$component" = "app" ]; then
  echo "==> testing the rendered nginx configs inside the image"
  # That exact variable list, not a bare envsubst: a bare one also eats
  # nginx's own $http_upgrade and the config then fails to parse.
  docker run --rm --entrypoint sh "$local_tag" -c '
    set -e
    export PORT=8080 SSL_PORT=8443 SSL_CERT_PATH=/tmp/c.pem SSL_KEY_PATH=/tmp/k.pem
    openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/k.pem -out /tmp/c.pem \
      -subj /CN=publish-check -days 1 >/dev/null 2>&1
    mkdir -p /tmp/nginx
    for t in nginx.conf nginx-https.conf; do
      envsubst "\${PORT} \${SSL_PORT} \${SSL_CERT_PATH} \${SSL_KEY_PATH}" \
        < /app/nginx/$t.template > /tmp/nginx/$t
      nginx -t -c /tmp/nginx/$t
    done'
fi

targets=("$gitlab_image:$tag" "$gitlab_image:latest")
if [ "$DOCKER_HUB" != "0" ]; then
  targets+=("$hub_image:$tag" "$hub_image:latest")
fi

for target in "${targets[@]}"; do
  docker tag "$local_tag" "$target"
done

for target in "${targets[@]}"; do
  echo "==> pushing $target"
  docker push "$target"
done

echo
echo "published $component $tag from $commit:"
for target in "${targets[@]}"; do
  echo "  $target"
done
