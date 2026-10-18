import * as p from '@clack/prompts';
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

function fail(msg: string): never {
  if (p.cancel) {
    p.cancel(msg);
  } else {
    console.error(msg);
  }
  process.exit(1);
}

async function main() {
  const args = parseArgs();

  if (!args.target) {
    fail('Usage: mise run release <patch|minor|major|x.y.z> [--dry-run] [--yes] [--json]');
  }

  const isNonInteractive = args.yes;
  if (!isNonInteractive) {
    p.intro('  release  —  Obsidian Template');
  }

  const validation = await validateReleaseAsync(args.target);
  if (!validation.valid) {
    fail(validation.error!);
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
  } else if (!isNonInteractive) {
    p.log.info(`${currentVersion ? `v${currentVersion}` : 'no previous tag'} → ${tag}\n${steps.map((s) => `  - ${s}`).join('\n')}`);
  } else {
    console.log(`${currentVersion ? `v${currentVersion}` : 'no previous tag'} → ${tag}`);
    for (const step of steps) console.log(`  - ${step}`);
  }

  if (args.dryRun) {
    if (!isNonInteractive) p.outro('Dry run: nothing was changed.');
    else console.log('Dry run: nothing was changed.');
    return;
  }

  if (!isNonInteractive) {
    const proceed = await p.confirm({ message: `Create release ${tag}?`, initialValue: true });
    if (p.isCancel(proceed) || !proceed) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
  }

  try {
    const result = await executeRelease({ target: args.target, dryRun: false });
    if (args.json) {
      console.log(JSON.stringify({ created: result.tag, version: result.version, previousVersion: result.previousVersion, date: result.date }, null, 2));
    } else if (!isNonInteractive) {
      p.outro(`Created ${result.tag}. Review, then publish with: git push --follow-tags`);
    } else {
      console.log(`Created ${result.tag}. Review, then publish with: git push --follow-tags`);
    }
  } catch (err) {
    fail(String(err));
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
