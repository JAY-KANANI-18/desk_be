import 'dotenv/config';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type _Object,
} from '@aws-sdk/client-s3';

interface RenameArgs {
  workspaceId?: string;
  prefix?: string;
  start: number;
  end: number;
  apply: boolean;
  overwrite: boolean;
  deleteSource: boolean;
  help: boolean;
}

interface RenamePlanItem {
  sourceKey: string;
  targetKey: string;
}

const DEFAULT_START = 1;
const DEFAULT_END = 200;
const STATIC_AVATAR_ROOT = 'static/avatars';

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}

function parseBooleanFlag(value: string | undefined): boolean {
  if (value === undefined) return true;
  return value !== 'false' && value !== '0' && value !== 'no';
}

function readOption(argv: string[], index: number): [string, number] {
  const current = argv[index];
  const equalsIndex = current.indexOf('=');
  if (equalsIndex >= 0) {
    return [current.slice(equalsIndex + 1), index];
  }

  const next = argv[index + 1];
  if (!next || next.startsWith('--')) {
    throw new Error(`Missing value for ${current}`);
  }

  return [next, index + 1];
}

function parseNumberOption(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseArgs(argv: string[]): RenameArgs {
  const args: RenameArgs = {
    start: DEFAULT_START,
    end: DEFAULT_END,
    apply: false,
    overwrite: false,
    deleteSource: true,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }

    if (arg.startsWith('--workspaceId') || arg.startsWith('--workspace-id')) {
      const [value, nextIndex] = readOption(argv, index);
      args.workspaceId = value;
      index = nextIndex;
      continue;
    }

    if (arg.startsWith('--prefix')) {
      const [value, nextIndex] = readOption(argv, index);
      args.prefix = value;
      index = nextIndex;
      continue;
    }

    if (arg.startsWith('--start')) {
      const [value, nextIndex] = readOption(argv, index);
      args.start = parseNumberOption('--start', value);
      index = nextIndex;
      continue;
    }

    if (arg.startsWith('--end')) {
      const [value, nextIndex] = readOption(argv, index);
      args.end = parseNumberOption('--end', value);
      index = nextIndex;
      continue;
    }

    if (arg.startsWith('--apply')) {
      args.apply = parseBooleanFlag(arg.split('=')[1]);
      continue;
    }

    if (arg.startsWith('--overwrite')) {
      args.overwrite = parseBooleanFlag(arg.split('=')[1]);
      continue;
    }

    if (arg === '--keep-source') {
      args.deleteSource = false;
      continue;
    }

    if (arg.startsWith('--delete-source')) {
      args.deleteSource = parseBooleanFlag(arg.split('=')[1]);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (args.end < args.start) {
    throw new Error('--end must be greater than or equal to --start');
  }

  return args;
}

function printHelp(): void {
  console.log(`
Rename static-avatar R2 objects to sequential names like 1.svg ... 200.svg.

Dry-run:
  npm run r2:rename-static-avatars

Apply rename:
  npm run r2:rename-static-avatars -- --apply

Options:
  --workspaceId=<id>      Uses static/avatars/<id>/ for older workspace-scoped folders.
  --prefix=<r2-prefix>    Custom R2 prefix. Overrides --workspaceId.
  --start=<number>        First target number. Default: 1.
  --end=<number>          Last target number. Default: 200.
  --apply                 Copy to numbered names and delete source objects.
  --keep-source           Copy only; do not delete original objects.
  --overwrite             Allow replacing existing numbered targets.
`);
}

function normalizePrefix(args: RenameArgs): string {
  const rawPrefix = args.prefix ?? (args.workspaceId ? `${STATIC_AVATAR_ROOT}/${args.workspaceId}` : STATIC_AVATAR_ROOT);
  const trimmedPrefix = rawPrefix.replace(/^\/+|\/+$/g, '');

  return `${trimmedPrefix}/`;
}

function getFileName(key: string): string {
  const parts = key.split('/');
  return parts[parts.length - 1] ?? key;
}

function getManagedNumber(key: string): number | null {
  const match = getFileName(key).match(/^(\d+)\.svg$/i);
  return match ? Number(match[1]) : null;
}

function isSvgObject(object: _Object): object is _Object & { Key: string } {
  return Boolean(object.Key && object.Key.toLowerCase().endsWith('.svg'));
}

function sortObjects(objects: Array<_Object & { Key: string }>): Array<_Object & { Key: string }> {
  return [...objects].sort((left, right) => {
    const leftTime = left.LastModified?.getTime() ?? 0;
    const rightTime = right.LastModified?.getTime() ?? 0;
    if (leftTime !== rightTime) return leftTime - rightTime;

    return left.Key.localeCompare(right.Key, undefined, { numeric: true });
  });
}

async function listObjects(client: S3Client, bucket: string, prefix: string): Promise<_Object[]> {
  const objects: _Object[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    objects.push(...(response.Contents ?? []));
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return objects;
}

function createPlan(
  objects: _Object[],
  prefix: string,
  args: RenameArgs,
): RenamePlanItem[] {
  const svgObjects = sortObjects(objects.filter(isSvgObject));
  const existingTargetKeys = new Set<string>();
  const sourceObjects: Array<_Object & { Key: string }> = [];

  for (const object of svgObjects) {
    const managedNumber = getManagedNumber(object.Key);
    const isManagedTarget =
      managedNumber !== null && managedNumber >= args.start && managedNumber <= args.end;

    if (isManagedTarget) {
      existingTargetKeys.add(object.Key);
      if (!args.overwrite) continue;
    }

    sourceObjects.push(object);
  }

  const targetKeys = Array.from(
    { length: args.end - args.start + 1 },
    (_, offset) => `${prefix}${args.start + offset}.svg`,
  ).filter((targetKey) => args.overwrite || !existingTargetKeys.has(targetKey));

  return sourceObjects.slice(0, targetKeys.length).map((sourceObject, index) => ({
    sourceKey: sourceObject.Key,
    targetKey: targetKeys[index],
  })).filter((item) => item.sourceKey !== item.targetKey);
}

function toCopySource(bucket: string, key: string): string {
  return `${bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`;
}

async function applyPlan(
  client: S3Client,
  bucket: string,
  plan: RenamePlanItem[],
  deleteSource: boolean,
): Promise<void> {
  for (let index = 0; index < plan.length; index += 1) {
    const item = plan[index];
    await client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: toCopySource(bucket, item.sourceKey),
        Key: item.targetKey,
        MetadataDirective: 'COPY',
      }),
    );

    if (deleteSource) {
      await client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: item.sourceKey,
        }),
      );
    }

    console.log(`${index + 1}/${plan.length}: ${item.sourceKey} -> ${item.targetKey}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const bucket = getRequiredEnv('R2_BUCKET');
  const prefix = normalizePrefix(args);
  const client = new S3Client({
    region: 'auto',
    endpoint: getRequiredEnv('R2_ENDPOINT'),
    credentials: {
      accessKeyId: getRequiredEnv('R2_ACCESS_KEY'),
      secretAccessKey: getRequiredEnv('R2_SECRET_KEY'),
    },
  });

  const objects = await listObjects(client, bucket, prefix);
  const plan = createPlan(objects, prefix, args);

  console.log(`Bucket: ${bucket}`);
  console.log(`Prefix: ${prefix}`);
  console.log(`Objects found: ${objects.length}`);
  console.log(`Planned renames: ${plan.length}`);

  if (plan.length === 0) {
    console.log('Nothing to rename.');
    return;
  }

  for (const item of plan) {
    console.log(`${item.sourceKey} -> ${item.targetKey}`);
  }

  if (!args.apply) {
    console.log('Dry-run only. Add --apply to rename objects in R2.');
    return;
  }

  await applyPlan(client, bucket, plan, args.deleteSource);
  console.log(args.deleteSource ? 'Rename complete.' : 'Copy complete. Original files kept.');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown rename error';
  console.error(message);
  process.exitCode = 1;
});
