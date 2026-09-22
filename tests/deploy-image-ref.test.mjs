import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const digest = `sha256:${"a".repeat(64)}`;
const ghcr = /^ghcr\.io\/jjgitt\/junjunorder@sha256:[a-f0-9]{64}$/;
const swr = /^swr\.cn-north-4\.myhuaweicloud\.com\/junjunorder\/junjunorder@sha256:[a-f0-9]{64}$/;
const acr = /^crpi-lz061y1f8ajv9wzf\.cn-guangzhou\.personal\.cr\.aliyuncs\.com\/junjunorder\/junjunorder@sha256:[a-f0-9]{64}$/;
const acrRepository = "crpi-lz061y1f8ajv9wzf.cn-guangzhou.personal.cr.aliyuncs.com/junjunorder/junjunorder";

test("deploy script accepts the GHCR, Huawei SWR and Aliyun ACR digest refs only", async () => {
  const deploy = await readFile(new URL("../deploy/ci/deploy.sh", import.meta.url), "utf8");
  assert.match(deploy, /ghcr_image='/);
  assert.match(deploy, /swr_image='/);
  assert.match(deploy, /acr_image='/);
  assert.ok(deploy.includes("jjgitt/junjunorder"));
  assert.ok(deploy.includes("junjunorder/junjunorder"));
  assert.match(deploy, /registry_host=swr\.cn-north-4\.myhuaweicloud\.com/);
  assert.match(deploy, /registry_host=crpi-lz061y1f8ajv9wzf\.cn-guangzhou\.personal\.cr\.aliyuncs\.com/);
  assert.ok(deploy.includes(`$2 == "${acrRepository}"`), "housekeeping prunes stale ACR digests too");
  assert.match(deploy, /\$current_ref" =~ \$acr_image/);
  assert.doesNotMatch(deploy, /SWR_PASSWORD\s*[:=]/);
  assert.doesNotMatch(deploy, /ACR_PASSWORD\s*[:=]/);
  assert.equal(ghcr.test(`ghcr.io/jjgitt/junjunorder@${digest}`), true);
  assert.equal(swr.test(`swr.cn-north-4.myhuaweicloud.com/junjunorder/junjunorder@${digest}`), true);
  assert.equal(acr.test(`${acrRepository}@${digest}`), true);
  assert.equal(ghcr.test(`ghcr.io/other/repo@${digest}`), false);
  assert.equal(swr.test(`swr.cn-north-4.myhuaweicloud.com/other/junjunorder@${digest}`), false);
  assert.equal(acr.test(`crpi-other.cn-guangzhou.personal.cr.aliyuncs.com/junjunorder/junjunorder@${digest}`), false);
  // Aliyun ACR usernames are account login names, so the stdin credential check must allow email-like values.
  assert.match(deploy, /\[\[ "\$registry_user" =~ \^\[\^\[:space:\]\[:cntrl:\]\]\+\$ && \$\{#registry_user\} -le 128 && -n "\$registry_token" \]\] \|\| exit 64/);
  assert.match(deploy, /prune_unused_project_images/);
  assert.match(deploy, /hongyun-order-app:latest/);
  assert.match(deploy, /docker image ls --no-trunc --format '\{\{\.ID\}\} \{\{\.Repository\}\}'/);
  assert.doesNotMatch(deploy, /docker image prune -/);
  assert.match(deploy, /pull_timeout_seconds=300/);
  assert.match(deploy, /pull_attempts=3/);
  assert.match(
    deploy,
    /timeout --signal=TERM --kill-after="\$\{pull_kill_after_seconds\}s" "\$\{timeout_seconds\}s" docker pull "\$ref"/,
  );
  assert.match(deploy, /pull_digest "\$seed_repository@\$digest" 1200 2/);
  assert.match(deploy, /Image pull failed; running service unchanged/);
  assert.match(deploy, /ACR is missing \$digest; pulling \$seed_repository and pushing ACR from this China server/);
  assert.match(deploy, /docker push "crpi-lz061y1f8ajv9wzf\.cn-guangzhou\.personal\.cr\.aliyuncs\.com\/junjunorder\/junjunorder:from-seed"/);
  assert.match(deploy, /timeout --signal=TERM --kill-after="\$\{pull_kill_after_seconds\}s" 600s/);
});

test("workflow does not push ACR from the US runner; the China server seeds ACR", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci-cd.yml", import.meta.url), "utf8");
  const rollback = await readFile(new URL("../deploy/ci/rollback/ghcr-20260915/ci-cd.yml", import.meta.url), "utf8");
  assert.match(workflow, /tags: hongyun:ci/);
  assert.match(workflow, /load: true/);
  assert.match(workflow, /Push image to GHCR/);
  assert.doesNotMatch(workflow, /Login to Huawei SWR/);
  assert.doesNotMatch(workflow, /Push image to Huawei SWR/);
  assert.doesNotMatch(workflow, /Push image to Aliyun ACR/);
  assert.doesNotMatch(workflow, /Login to Aliyun ACR/);
  assert.match(workflow, /docker tag hongyun:ci/);
  assert.doesNotMatch(workflow, /docker push "\$tag"/);
  assert.match(workflow, /seed_repository='ghcr\.io\/jjgitt\/junjunorder'/);
  assert.doesNotMatch(workflow, /imagetools create/);
  assert.match(workflow, /provenance: false/);
  assert.match(workflow, /sbom: false/);
  assert.match(workflow, /REQUESTED_REGISTRY.*IMAGE_REGISTRY/);
  assert.match(workflow, /selected=acr/);
  assert.match(workflow, /the China server will seed it from/);
  assert.match(workflow, /echo "seed=\$seed" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /echo "repository=\$repository" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /IMAGE_REPOSITORY: \$\{\{ needs\.publish\.outputs\.repository \|\| 'ghcr\.io\/jjgitt\/junjunorder' \}\}/);
  assert.match(workflow, /needs\.publish\.outputs\.registry == 'swr' && secrets\.SWR_USERNAME/);
  assert.match(workflow, /needs\.publish\.outputs\.registry == 'acr' && secrets\.ACR_USERNAME/);
  assert.match(workflow, /TARGET_REGISTRY:-\}" == acr/);
  assert.match(workflow, /SEED_REPOSITORY/);
  assert.match(workflow, /swr\\\.cn-north-4\\\.myhuaweicloud\\\.com\/junjunorder\/junjunorder/, "deploy job whitelists the SWR repository");
  assert.match(workflow, /crpi-lz061y1f8ajv9wzf\\\.cn-guangzhou\\\.personal\\\.cr\\\.aliyuncs\\\.com\/junjunorder\/junjunorder/, "deploy job whitelists the ACR repository");
  assert.match(workflow, /ghcr\.io\/jjgitt\/junjunorder/);
  assert.match(rollback, /"\$DEPLOY_USER@\$DEPLOY_HOST" "ghcr\.io\/jjgitt\/junjunorder@\$IMAGE_DIGEST"/);
  assert.doesNotMatch(workflow, /SWR_PASSWORD:\s*['"]?[A-Za-z0-9+/=]{20,}/);
  assert.doesNotMatch(workflow, /ACR_PASSWORD:\s*['"]?[A-Za-z0-9+/=]{20,}/);
});
