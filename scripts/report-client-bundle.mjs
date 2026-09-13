import { brotliCompressSync, gzipSync } from 'node:zlib';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ASSET_DIRECTORY = fileURLToPath(new URL('../dist/client/assets', import.meta.url));
const REPORTABLE_EXTENSIONS = new Set(['.css', '.js', '.wasm']);
const SOURCE_MAP_EXTENSION = '.map';

function collectExcludedSourceMaps(directory) {
  return walkFiles(directory)
    .filter((path) => path.endsWith(SOURCE_MAP_EXTENSION))
    .map((path) => relative(directory, path))
    .sort();
}

function collectBundleAssets(directory) {
  return (
    walkFiles(directory)
      // Source maps are intentionally excluded from static deployment by the
      // generated .assetsignore and therefore are not part of deployable bytes.
      .filter((path) => !path.endsWith(SOURCE_MAP_EXTENSION) && REPORTABLE_EXTENSIONS.has(extname(path)))
      .map((path) => {
        const contents = readFileSync(path);

        return {
          file: relative(directory, path),
          rawBytes: contents.byteLength,
          gzipBytes: gzipSync(contents).byteLength,
          brotliBytes: brotliCompressSync(contents).byteLength,
        };
      })
      .sort((left, right) => right.rawBytes - left.rawBytes || left.file.localeCompare(right.file))
  );
}

function summarizeBundleAssets(assets) {
  return assets.reduce(
    (totals, asset) => ({
      rawBytes: totals.rawBytes + asset.rawBytes,
      gzipBytes: totals.gzipBytes + asset.gzipBytes,
      brotliBytes: totals.brotliBytes + asset.brotliBytes,
    }),
    { rawBytes: 0, gzipBytes: 0, brotliBytes: 0 },
  );
}

function assetsOverRawLimit(assets, maxRawKilobytes) {
  const maxRawBytes = maxRawKilobytes * 1000;

  return assets.filter((asset) => asset.rawBytes > maxRawBytes);
}

/**
 * @param {{ brotliBytes: number, gzipBytes: number }} totals
 * @param {{ maxTotalBrotliKilobytes?: number | null, maxTotalGzipKilobytes?: number | null }} limits
 */
function totalSizeLimitErrors(totals, { maxTotalBrotliKilobytes = null, maxTotalGzipKilobytes = null }) {
  const errors = [];
  if (maxTotalGzipKilobytes !== null && totals.gzipBytes > maxTotalGzipKilobytes * 1000) {
    errors.push(`total gzip size exceeds ${maxTotalGzipKilobytes} kB`);
  }
  if (maxTotalBrotliKilobytes !== null && totals.brotliBytes > maxTotalBrotliKilobytes * 1000) {
    errors.push(`total brotli size exceeds ${maxTotalBrotliKilobytes} kB`);
  }
  return errors;
}

function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    return entry.isDirectory() ? walkFiles(path) : [path];
  });
}

function parseArguments(args) {
  const options = {
    directory: DEFAULT_ASSET_DIRECTORY,
    json: false,
    limit: 20,
    maxRawKilobytes: null,
    maxTotalBrotliKilobytes: null,
    maxTotalGzipKilobytes: null,
  };

  for (const argument of args) {
    if (argument === '--json') {
      options.json = true;
    } else if (argument.startsWith('--directory=')) {
      options.directory = fileURLToPath(new URL(argument.slice('--directory='.length), `file://${process.cwd()}/`));
    } else if (argument.startsWith('--limit=')) {
      options.limit = Number.parseInt(argument.slice('--limit='.length), 10);
    } else if (argument.startsWith('--max-raw-kb=')) {
      options.maxRawKilobytes = Number.parseFloat(argument.slice('--max-raw-kb='.length));
    } else if (argument.startsWith('--max-total-gzip-kb=')) {
      options.maxTotalGzipKilobytes = Number.parseFloat(argument.slice('--max-total-gzip-kb='.length));
    } else if (argument.startsWith('--max-total-brotli-kb=')) {
      options.maxTotalBrotliKilobytes = Number.parseFloat(argument.slice('--max-total-brotli-kb='.length));
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    throw new Error('--limit must be a positive integer.');
  }

  if (options.maxRawKilobytes !== null && !(options.maxRawKilobytes > 0)) {
    throw new Error('--max-raw-kb must be a positive number.');
  }
  if (options.maxTotalGzipKilobytes !== null && !(options.maxTotalGzipKilobytes > 0)) {
    throw new Error('--max-total-gzip-kb must be a positive number.');
  }
  if (options.maxTotalBrotliKilobytes !== null && !(options.maxTotalBrotliKilobytes > 0)) {
    throw new Error('--max-total-brotli-kb must be a positive number.');
  }

  return options;
}

function formatKilobytes(bytes) {
  return `${(bytes / 1000).toFixed(1)} kB`;
}

function printReport(assets, excludedSourceMaps, options) {
  const totals = summarizeBundleAssets(assets);
  const oversizedAssets = options.maxRawKilobytes === null ? [] : assetsOverRawLimit(assets, options.maxRawKilobytes);
  const totalLimitErrors = totalSizeLimitErrors(totals, options);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          assets,
          excludedSourceMaps,
          oversizedAssets,
          totalLimitErrors,
          totals,
        },
        null,
        2,
      ),
    );
  } else {
    console.log('Largest client assets (raw / gzip / brotli)');

    for (const asset of assets.slice(0, options.limit)) {
      console.log(
        `${asset.file.padEnd(48)} ${formatKilobytes(asset.rawBytes).padStart(10)} / ${formatKilobytes(asset.gzipBytes).padStart(9)} / ${formatKilobytes(asset.brotliBytes).padStart(9)}`,
      );
    }

    console.log(
      `\n${assets.length} assets total: ${formatKilobytes(totals.rawBytes)} raw / ${formatKilobytes(totals.gzipBytes)} gzip / ${formatKilobytes(totals.brotliBytes)} brotli`,
    );
    console.log(`${excludedSourceMaps.length} client source map(s) excluded from deployment and bundle accounting.`);

    if (oversizedAssets.length > 0) {
      console.error(
        `\n${oversizedAssets.length} asset(s) exceed the ${options.maxRawKilobytes} kB raw limit: ${oversizedAssets.map((asset) => asset.file).join(', ')}`,
      );
    }
    for (const error of totalLimitErrors) {
      console.error(`\n${error}.`);
    }
  }

  return oversizedAssets.length === 0 && totalLimitErrors.length === 0;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const assets = collectBundleAssets(options.directory);
  const excludedSourceMaps = collectExcludedSourceMaps(options.directory);
  process.exitCode = printReport(assets, excludedSourceMaps, options) ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
