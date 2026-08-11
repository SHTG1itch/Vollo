import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// image-size has no patched release as of 2026-08-10. Metro only processes
// repository-owned build assets, so these exact DoS advisories are accepted
// until upstream publishes a fix. Every other high/critical advisory fails.
const reviewedSources = new Set(['1138808', '1138809']);

function advisorySources(report, name, seen = new Set()) {
  if (seen.has(name)) return new Set();
  const vulnerability = report.vulnerabilities?.[name];
  if (!vulnerability) return new Set([`unresolved:${name}`]);

  const nextSeen = new Set(seen).add(name);
  const sources = new Set();
  for (const via of vulnerability.via ?? []) {
    if (typeof via === 'string') {
      for (const source of advisorySources(report, via, nextSeen)) sources.add(source);
    } else {
      sources.add(String(via.source ?? via.url ?? `unresolved:${name}`));
    }
  }
  return sources;
}

export function unexpectedHighAdvisories(report) {
  return Object.entries(report.vulnerabilities ?? {}).flatMap(([name, vulnerability]) => {
    if (!['high', 'critical'].includes(vulnerability.severity)) return [];
    const sources = [...advisorySources(report, name)].sort();
    if (sources.length === 0) sources.push(`unresolved:${name}`);
    return sources.every((source) => reviewedSources.has(source)) ? [] : [{ name, sources }];
  });
}

function main() {
  if (!process.env.npm_execpath) throw new Error('Run this gate through npm run audit:mobile.');
  const result = spawnSync(process.execPath, [process.env.npm_execpath, 'audit', '--omit=dev', '--json'], {
    cwd: fileURLToPath(new URL('../mobile/', import.meta.url)),
    encoding: 'utf8',
  });
  if (result.error) throw result.error;

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(`npm audit did not return JSON: ${result.stderr.trim() || 'no diagnostic'}`);
  }
  if (report.error) throw new Error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);

  const unexpected = unexpectedHighAdvisories(report);
  if (unexpected.length > 0) {
    console.error('Unexpected high/critical mobile dependency advisories:');
    for (const finding of unexpected) console.error(`- ${finding.name}: ${finding.sources.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const accepted = Object.values(report.vulnerabilities ?? {})
    .filter((vulnerability) => ['high', 'critical'].includes(vulnerability.severity)).length;
  if (accepted > 0) {
    console.warn(`Accepted ${accepted} dependency-chain finding(s) from reviewed image-size advisories 1138808/1138809.`);
  } else {
    console.log('Mobile dependency audit: PASS');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
