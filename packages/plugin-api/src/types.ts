export interface DisplayField {
  label: string;
  value: string;
}

export interface DisplayFields {
  title: string;
  subtitle?: string;
  date?: string;
  fields: DisplayField[];
}

export type QualityExtra = string | number | boolean;

export interface QualityTokens {
  resolution?: number;
  source?: string;
  videoCodec?: string;
  audioCodec?: string;
  bitrateKbps?: number;
  sizeBytes?: number;
  releaseGroup?: string;
  extras?: Record<string, QualityExtra>;
}

export interface ParsedRelease {
  identityKey: string;
  display: DisplayFields;
  quality: QualityTokens;
}

export interface DownloadedFile {
  absolutePath: string;
  relativePath: string;
  sizeBytes: number;
}

export interface ImportFile {
  source: string;
  destination: string;
}

export interface ImportPlan {
  files: ImportFile[];
}

export interface MediaTypePlugin {
  readonly id: string;
  readonly displayName: string;
  parse(releaseName: string): ParsedRelease | null;
  score(quality: QualityTokens): number;
  planImport(media: ParsedRelease, files: DownloadedFile[]): ImportPlan | null;
}

/**
 * A plugin's own configuration block, passed through from `plugins.<package>`
 * verbatim. String lists are permitted because some plugin-specific knowledge
 * is irreducibly a list — the scenes plugin's known-site names, for one — and
 * encoding those as a delimited string would make every plugin invent its own
 * escaping for names that contain the delimiter.
 */
export type PluginConfig = Record<string, string | number | boolean | readonly string[]>;

export type PluginFactory = (config: PluginConfig) => MediaTypePlugin;
