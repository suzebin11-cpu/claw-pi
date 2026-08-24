export const GATEWAY_RELOAD_BUNDLE_PATTERN = /^server\.impl-.*\.js$/u;

export const CLAWPI_XAI_RELOAD_NORMALIZATION_MARKER =
  "isClawPiImplicitXaiWebSearchDefault";

const DIFF_CONFIG_PATHS_SEARCH = [
  'function diffConfigPaths(prev, next, prefix = "") {',
  "\tif (prev === next) return [];",
].join("\n");

const DIFF_CONFIG_PATHS_REPLACEMENT = [
  "function isClawPiImplicitXaiWebSearchDefault(value) {",
  "\treturn value === void 0 || isPlainObject(value) && Object.keys(value).length === 0;",
  "}",
  'function diffConfigPaths(prev, next, prefix = "") {',
  '\tif (prefix === "plugins.entries.xai.config.webSearch" && isClawPiImplicitXaiWebSearchDefault(prev) && isClawPiImplicitXaiWebSearchDefault(next)) return [];',
  "\tif (prev === next) return [];",
].join("\n");

export function patchOpenClawGatewayReloadSource(
  source,
  label = "gateway bundle",
) {
  if (source.includes(CLAWPI_XAI_RELOAD_NORMALIZATION_MARKER)) {
    return { source, patched: false };
  }
  if (!source.includes(DIFF_CONFIG_PATHS_SEARCH)) {
    throw new Error(
      `Unable to locate OpenClaw config diff anchor in ${label}.`,
    );
  }
  return {
    source: source.replace(
      DIFF_CONFIG_PATHS_SEARCH,
      DIFF_CONFIG_PATHS_REPLACEMENT,
    ),
    patched: true,
  };
}
