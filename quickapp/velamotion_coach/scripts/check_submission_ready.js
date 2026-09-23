#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')
const { PNG } = require('pngjs')

const root = path.resolve(__dirname, '..')
const outPath = path.join(root, 'artifacts/submission/submission_check_report.json')
const releaseRel = 'dist/com.velamotion.coach.release.1.0.0.rpk'
const zipRel = 'artifacts/submission/velamotion_coach_submission.zip'
const mockRel = 'artifacts/mock_verification/official_mock_report.json'
const manifestRel = 'artifacts/submission/velamotion_submission_manifest.json'
const zipManifestSuffix = 'artifacts/submission/velamotion_submission_manifest.json'

const expectedScreenshots = [
  ['core_01_home.png', '#3EBE9B'],
  ['core_02_coach.png', '#62A9E8'],
  ['core_03_timeline.png', '#6E7FEA'],
  ['core_04_sync_review.png', '#D66B8C'],
]

const required = [
  'LICENSE',
  'scripts/export_codex_contest_log.py',
  'scripts/create_submission_documents.py',
  'docs/作品介绍.pdf',
  'docs/作品介绍.docx',
  'skills/openvela-watch-acceptance/SKILL.md',
  'README.md',
  '.gitignore',
  'src/manifest.json',
  'src/pages/index/index.ux',
  'package.json',
  'package-lock.json',
  releaseRel,
  zipRel,
  'docs/submission_package.md',
  'docs/privacy_statement.md',
  'docs/device_boundary.md',
  'docs/true_device_validation.md',
  'docs/model_migration.md',
  'docs/sync_export.md',
  'docs/official_mock_acceptance.md',
  'docs/demo_storyboard.md',
  mockRel,
  'artifacts/model_migration/model_asset_report.json',
  'artifacts/final_demo/auto_carousel/core_demo_storyboard.md',
  'artifacts/final_demo/auto_carousel/velamotion_core_demo.mp4',
  manifestRel,
]

function abs(rel) { return path.join(root, rel) }
function exists(rel) { return fs.existsSync(abs(rel)) }
function size(rel) { return exists(rel) ? fs.statSync(abs(rel)).size : 0 }
function md5(file) { return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex') }
function sha256Buffer(value) { return crypto.createHash('sha256').update(value).digest('hex') }
function sha256File(rel) { return exists(rel) ? sha256Buffer(fs.readFileSync(abs(rel))) : null }
function readJson(rel) {
  try { return JSON.parse(fs.readFileSync(abs(rel), 'utf8')) } catch (e) { return null }
}
function rgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}
function colorDistance(a, b) {
  const dr = a[0] - b[0]
  const dg = a[1] - b[1]
  const db = a[2] - b[2]
  return Math.sqrt(dr * dr + dg * dg + db * db)
}
function detectMarker(file) {
  try {
    const png = PNG.sync.read(fs.readFileSync(file))
    const x0 = Math.max(0, Math.round(png.width * 0.44))
    const x1 = Math.min(png.width - 1, Math.round(png.width * 0.56))
    const y1 = Math.min(png.height - 1, 16)
    const scores = expectedScreenshots.map((entry, index) => ({ index, score: 0, count: 0, target: rgb(entry[1]) }))
    for (let y = 0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const offset = (y * png.width + x) * 4
        const pixel = [png.data[offset], png.data[offset + 1], png.data[offset + 2]]
        for (const item of scores) {
          const threshold = item.index === 1 ? 55 : 70
          const distance = colorDistance(pixel, item.target)
          if (distance < threshold) {
            item.score += threshold - distance
            item.count += 1
          }
        }
      }
    }
    scores.sort((a, b) => b.score - a.score)
    const best = scores[0]
    const second = scores[1] || { score: 0 }
    return best && best.count >= 8 && best.score >= 160 && best.score - second.score >= 80
      ? { index: best.index, score: Math.round(best.score), margin: Math.round(best.score - second.score), count: best.count }
      : null
  } catch (e) {
    return null
  }
}
function listFiles(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name)
    const stat = fs.statSync(file)
    if (stat.isDirectory()) out.push(...listFiles(file))
    else out.push(file)
  }
  return out
}
function archiveEntries(rel) {
  if (!exists(rel)) return []
  const result = spawnSync('unzip', ['-Z1', abs(rel)], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.split('\n').filter(Boolean) : []
}
function archiveFile(rel, entry) {
  if (!exists(rel) || !entry) return null
  const result = spawnSync('unzip', ['-p', abs(rel), entry], {
    maxBuffer: 64 * 1024 * 1024,
  })
  return result.status === 0 && Buffer.isBuffer(result.stdout) ? result.stdout : null
}
function localNodeScriptTargets(packageJson) {
  const scripts = packageJson && packageJson.scripts ? packageJson.scripts : {}
  return Object.keys(scripts).map((name) => {
    const command = typeof scripts[name] === 'string' ? scripts[name] : ''
    const tokens = command.trim().split(/\s+/)
    const nodeIndex = tokens.findIndex((token) => /(^|\/)node(?:\.exe)?$/.test(token))
    let target = ''
    if (nodeIndex >= 0) {
      let index = nodeIndex + 1
      while (index < tokens.length && tokens[index].startsWith('-')) index += 1
      if (index < tokens.length) target = tokens[index].replace(/^['"]|['"]$/g, '')
    }
    return {
      name,
      command,
      target,
      exists: !target || exists(target),
    }
  }).filter((item) => item.target)
}

const missing = required.filter((rel) => !exists(rel))
const screenshotsDir = abs('artifacts/final_demo/auto_carousel')
const expectedNames = expectedScreenshots.map((entry) => entry[0])
const screenshotFiles = fs.existsSync(screenshotsDir)
  ? expectedNames.filter((name) => fs.existsSync(path.join(screenshotsDir, name)))
  : []
const hashes = screenshotFiles.map((name) => md5(path.join(screenshotsDir, name)))
const markerChecks = expectedScreenshots.map(([name], expectedIndex) => {
  const file = path.join(screenshotsDir, name)
  const detected = fs.existsSync(file) ? detectMarker(file) : null
  return { name, expectedIndex, detectedIndex: detected ? detected.index : null, ok: Boolean(detected && detected.index === expectedIndex), detected }
})
const screenshotOk =
  JSON.stringify(screenshotFiles) === JSON.stringify(expectedNames) &&
  new Set(hashes).size === expectedNames.length &&
  markerChecks.every((item) => item.ok)

const mockReport = readJson(mockRel)
const mockOk = Boolean(mockReport && mockReport.dryRun === false && mockReport.verification && mockReport.verification.passed === true)

const packageJson = readJson('package.json')
const packageScriptTargets = localNodeScriptTargets(packageJson)
const packageScriptTargetsOk = Boolean(packageJson) &&
  packageScriptTargets.length > 0 &&
  packageScriptTargets.every((item) => item.exists)

const releaseEntries = archiveEntries(releaseRel)
const releaseStructureOk = ['META-INF/CERT', 'manifest.json', 'manifest-watch.json', 'app.js']
  .every((entry) => releaseEntries.includes(entry))
const sourceFiles = listFiles(abs('src'))
const newestSourceMtime = sourceFiles.reduce((max, file) => Math.max(max, fs.statSync(file).mtimeMs), 0)
const releaseMtime = exists(releaseRel) ? fs.statSync(abs(releaseRel)).mtimeMs : 0
const releaseFresh = releaseMtime >= newestSourceMtime

const zipEntries = archiveEntries(zipRel)
const forbiddenZipEntries = zipEntries.filter((entry) =>
  /(^|\/)logs(\/|$)|\.jsonl$|ai_log_validation\.txt$/.test(entry) ||
  /(^|\/)node_modules(\/|$)|(^|\/)build(\/|$)|private\.pem$|(^|\/)com\.velamotion\.coach(\/|$)/.test(entry),
)
const zipManifestEntry = zipEntries.find((entry) => /artifacts\/submission\/velamotion_submission_manifest\.json$/.test(entry))
let zipManifest = null
if (zipManifestEntry) {
  const contents = archiveFile(zipRel, zipManifestEntry)
  try { zipManifest = JSON.parse(contents ? contents.toString('utf8') : '') } catch (e) {}
}
const zipPrefix = zipManifestEntry && zipManifestEntry.endsWith(zipManifestSuffix)
  ? zipManifestEntry.slice(0, -zipManifestSuffix.length)
  : ''
const rootSourceFiles = listFiles(abs('src')).map((file) =>
  path.relative(root, file).replace(/\\/g, '/'),
)
const zipCheckedFiles = Array.from(new Set([
  ...required.filter((rel) => ![zipRel, manifestRel].includes(rel)),
  ...expectedNames.map((name) => `artifacts/final_demo/auto_carousel/${name}`),
  ...['docs', 'skills'].flatMap((dir) => listFiles(abs(dir))).filter((file) => !file.endsWith('/docs/validation/ai_log_validation.txt')).map((file) => path.relative(root, file).replace(/\\/g, '/')),
  'README.md',
  'package.json',
  'package-lock.json',
  releaseRel,
  ...rootSourceFiles,
  ...packageScriptTargets.map((item) => item.target),
])).sort()
const zipFileChecks = zipCheckedFiles.map((rel) => {
  const entry = zipPrefix ? zipPrefix + rel : ''
  const contents = archiveFile(zipRel, entry)
  const sourceSha256 = sha256File(rel)
  const archiveSha256 = contents ? sha256Buffer(contents) : null
  return {
    path: rel,
    present: Boolean(contents),
    matches: Boolean(sourceSha256 && archiveSha256 && sourceSha256 === archiveSha256),
  }
})
const zipContentMatches = zipFileChecks.length > 0 && zipFileChecks.every((item) => item.matches)
const zipMismatchedFiles = zipFileChecks.filter((item) => !item.matches)
const releaseSha256 = sha256File(releaseRel)
const submissionManifest = readJson(manifestRel)
const rootManifestReleaseMatches = Boolean(
  releaseSha256 &&
  submissionManifest &&
  submissionManifest.releaseRpk &&
  submissionManifest.releaseRpk.sha256 === releaseSha256,
)
const zipManifestReleaseMatches = Boolean(
  releaseSha256 &&
  zipManifest &&
  zipManifest.releaseRpk &&
  zipManifest.releaseRpk.sha256 === releaseSha256,
)
const zipOk = zipEntries.length > 0 &&
  forbiddenZipEntries.length === 0 &&
  Boolean(zipManifest && zipManifest.zipPath) &&
  zipContentMatches &&
  rootManifestReleaseMatches &&
  zipManifestReleaseMatches

const sourceText = exists('src/pages/index/index.ux') ? fs.readFileSync(abs('src/pages/index/index.ux'), 'utf8') : ''
const productModeOk = /const AUTO_START_DEMO = false;/.test(sourceText) && /const AUTO_PAGE_DEMO = false;/.test(sourceText)

const report = {
  generatedAt: new Date().toISOString(),
  ok: missing.length === 0 && packageScriptTargetsOk && screenshotOk && mockOk && releaseStructureOk && releaseFresh && zipOk && productModeOk,
  missing,
  aiCodingLogs: { included: false, reason: 'withheld_by_author', officialRequirementMet: false },
  competitionRequirementsComplete: false,
  packageScripts: {
    ok: packageScriptTargetsOk,
    targets: packageScriptTargets,
  },
  productMode: { ok: productModeOk, autoStartDisabled: /AUTO_START_DEMO = false/.test(sourceText), autoPageDisabled: /AUTO_PAGE_DEMO = false/.test(sourceText) },
  releaseRpk: {
    path: releaseRel,
    sizeBytes: size(releaseRel),
    structureOk: releaseStructureOk,
    freshAgainstSource: releaseFresh,
    entryCount: releaseEntries.length,
  },
  officialMock: {
    path: mockRel,
    ok: mockOk,
    dryRun: mockReport ? mockReport.dryRun : null,
    verificationPassed: mockReport && mockReport.verification ? mockReport.verification.passed : null,
  },
  screenshots: {
    count: screenshotFiles.length,
    unique: new Set(hashes).size,
    expected: expectedNames.length,
    namesExact: JSON.stringify(screenshotFiles) === JSON.stringify(expectedNames),
    pageMappingOk: markerChecks.every((item) => item.ok),
    ok: screenshotOk,
    files: screenshotFiles,
    markerChecks,
  },
  submissionZip: {
    path: zipRel,
    ok: zipOk,
    sizeBytes: size(zipRel),
    entryCount: zipEntries.length,
    forbiddenEntries: forbiddenZipEntries,
    embeddedManifestHasZipPath: Boolean(zipManifest && zipManifest.zipPath),
    checkedFileCount: zipFileChecks.length,
    contentMatchesCurrentInputs: zipContentMatches,
    mismatchedFiles: zipMismatchedFiles,
    rootManifestReleaseHashMatches: rootManifestReleaseMatches,
    embeddedManifestReleaseHashMatches: zipManifestReleaseMatches,
  },
  note: 'The current acceptance set is four core pages; preserved legacy 11-page artifacts are ignored. Dry-run Mock evidence, stale RPKs, mislabeled screenshots, stale ZIP manifests and private/heavy files fail this check.',
}
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(`[submit] ok=${report.ok}`)
console.log(`[submit] missing=${missing.length}`)
console.log('[submit] AI Coding logs withheld by author; official log requirement remains outstanding')
console.log(`[submit] package script targets=${packageScriptTargetsOk}`)
console.log(`[submit] release structure=${releaseStructureOk} fresh=${releaseFresh}`)
console.log(`[submit] official mock live=${mockOk}`)
console.log(`[submit] screenshots=${screenshotFiles.length} unique=${report.screenshots.unique} mapping=${report.screenshots.pageMappingOk}`)
console.log(`[submit] zip ok=${zipOk} content=${zipContentMatches} forbidden=${forbiddenZipEntries.length}`)
console.log(`[submit] report=${outPath}`)
if (!report.ok) process.exit(1)
