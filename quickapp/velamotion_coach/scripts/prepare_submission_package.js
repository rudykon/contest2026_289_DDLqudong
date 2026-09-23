#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const submissionRoot = path.join(root, 'artifacts/submission')
const stagingName = 'velamotion_coach_submission'
const staging = path.join(submissionRoot, stagingName)
const zipPath = path.join(submissionRoot, `${stagingName}.zip`)
const manifestPath = path.join(submissionRoot, 'velamotion_submission_manifest.json')
const currentScreenshots = [
  'core_01_home.png',
  'core_02_coach.png',
  'core_03_timeline.png',
  'core_04_sync_review.png',
]
const currentDemoArtifacts = [
  ...currentScreenshots.map((name) => `artifacts/final_demo/auto_carousel/${name}`),
  'artifacts/final_demo/auto_carousel/core_demo_storyboard.md',
  'artifacts/final_demo/auto_carousel/core_demo.ffconcat',
  'artifacts/final_demo/auto_carousel/velamotion_core_demo.mp4',
]

const includePaths = [
  'README.md',
  'LICENSE',
  'package.json',
  'package-lock.json',
  '.gitignore',
  'src',
  'docs',
  'skills',
  'sign/README.md',
  'scripts/export_codex_contest_log.py',
  'scripts/create_submission_documents.py',
  'scripts/test_core_modules.mjs',
  'scripts/smoke_motion_engine.mjs',
  'scripts/inject_official_sensor_mock.js',
  'scripts/final_demo_capture.js',
  'scripts/model_migration_inventory.js',
  'scripts/check_submission_ready.js',
  'scripts/prepare_submission_package.js',
  'dist/com.velamotion.coach.release.1.0.0.rpk',
  'artifacts/mock_verification/official_mock_report.json',
  'artifacts/model_migration/model_asset_report.json',
  ...currentDemoArtifacts,
]

const deny = [
  /(^|\/)logs(\/|$)/,
  /\.jsonl$/,
  /docs\/validation\/ai_log_validation\.txt$/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)build(\/|$)/,
  /(^|\/)com\.velamotion\.coach(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)sign\/release\/private\.pem$/,
]

function relOf(abs) {
  return path.relative(root, abs).replace(/\\/g, '/')
}

function shouldDeny(abs) {
  const rel = relOf(abs)
  return deny.some((re) => re.test(rel))
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function copyFile(src, dst) {
  ensureDir(path.dirname(dst))
  fs.copyFileSync(src, dst)
}

function copyRecursive(rel) {
  const src = path.join(root, rel)
  if (!fs.existsSync(src) || shouldDeny(src)) return []
  const copied = []
  const st = fs.statSync(src)
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(src)) {
      copied.push(...copyRecursive(path.join(rel, name)))
    }
    return copied
  }
  const dst = path.join(staging, rel)
  copyFile(src, dst)
  copied.push(rel.replace(/\\/g, '/'))
  return copied
}

function sha256(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
}

function fileInfo(rel) {
  const abs = path.join(root, rel)
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return null
  return { path: rel, sizeBytes: fs.statSync(abs).size, sha256: sha256(abs) }
}

function main() {
  ensureDir(submissionRoot)
  fs.rmSync(staging, { recursive: true, force: true })
  ensureDir(staging)

  const copied = []
  includePaths.forEach((rel) => copied.push(...copyRecursive(rel)))

  const release = fileInfo('dist/com.velamotion.coach.release.1.0.0.rpk')
  const video = fileInfo('artifacts/final_demo/auto_carousel/velamotion_core_demo.mp4')
  const screenshotsDir = path.join(root, 'artifacts/final_demo/auto_carousel')
  const screenshots = fs.existsSync(screenshotsDir)
    ? currentScreenshots.filter((name) => fs.existsSync(path.join(screenshotsDir, name)))
    : []

  const manifest = {
    generatedAt: new Date().toISOString(),
    packageName: 'com.velamotion.coach',
    aiCodingLogs: { included: false, reason: 'withheld_by_author', officialRequirementMet: false },
    appName: 'VelaMotion Coach / 腕动教练',
    stagingDir: path.relative(root, staging),
    zipPath: path.relative(root, zipPath),
    releaseRpk: release,
    demoVideo: video,
    screenshotCount: screenshots.length,
    screenshots,
    copiedCount: copied.length,
    copied,
    excluded: ['logs/', '*.jsonl', 'docs/validation/ai_log_validation.txt', 'node_modules/', 'build/', 'com.velamotion.coach/', '.git/', 'sign/release/private.pem'],
    boundary: 'No physical Xiaomi watch/band was available on this server; true-device validation is implemented as an in-app diagnostic workflow and documentation.',
  }

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  copyFile(manifestPath, path.join(staging, 'artifacts/submission/velamotion_submission_manifest.json'))

  fs.rmSync(zipPath, { force: true })
  const zip = spawnSync('zip', ['-qr', zipPath, stagingName], { cwd: submissionRoot, encoding: 'utf-8' })
  if (zip.status === 0) {
    const after = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    after.zip = { sizeBytes: fs.statSync(zipPath).size, sha256: sha256(zipPath) }
    fs.writeFileSync(manifestPath, `${JSON.stringify(after, null, 2)}\n`)
    console.log(`[submit] zip=${zipPath}`)
  } else {
    console.log('[submit] zip command not available or failed; staging directory is ready')
  }

  console.log(`[submit] staging=${staging}`)
  console.log(`[submit] manifest=${manifestPath}`)
  console.log(`[submit] copied=${copied.length}`)
}

main()
