import { executeRelease, validateReleaseAsync } from '../lib/release.ts';

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run'),
    yes: args.includes('--yes'),
    json: args.includes('--json'),
    target: args.find((a) => !a.startsWith('--')),
  };
}

async function main() {
  const args = parseArgs();

  if (!args.target) {
    console.error('Usage: node scripts/agent/release.ts <patch|minor|major|x.y.z> [--dry-run] [--yes] [--json]');
    process.exit(1);
  }

  const validation = await validateReleaseAsync(args.target);
  if (!validation.valid) {
    console.error(validation.error);
    process.exit(1);
  }

  const { currentVersion, version, tag, baseline, date, steps } = validation;

  if (args.json) {
    console.log(JSON.stringify({
      previousVersion: currentVersion,
      version,
      tag,
      date,
      baseline,
      steps,
      dryRun: args.dryRun,
    }, null, 2));
  } else {
    console.log(`${currentVersion ? `v${currentVersion}` : 'no previous tag'} → ${tag}`);
    for (const step of steps) console.log(`  - ${step}`);
  }

  if (args.dryRun) {
    console.log('Dry run: nothing was changed.');
    return;
  }

  if (!args.yes) {
    console.error('Pass --yes to confirm release creation (non-interactive mode).');
    process.exit(1);
  }

  try {
    const result = await executeRelease({ target: args.target, dryRun: false });
    if (args.json) {
      console.log(JSON.stringify({ created: result.tag, version: result.version, previousVersion: result.previousVersion, date: result.date }, null, 2));
    } else {
      console.log(`Created ${result.tag}. Review, then publish with: git push --follow-tags`);
    }
  } catch (err) {
    console.error(String(err));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
