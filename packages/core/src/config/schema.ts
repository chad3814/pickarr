import { z } from 'zod';

export const pathMappingSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

export const downloadClientSchema = z.object({
  id: z.string().min(1),
  type: z.literal('sabnzbd'),
  url: z.string().url(),
  apiKey: z.string().min(1),
  category: z.string().min(1),
  importMode: z.enum(['move', 'copy']),
  pathMappings: z.array(pathMappingSchema).default([]),
});

export const feedSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  plugin: z.string().min(1),
  intervalSeconds: z.number().int().positive().default(900),
});

export const configSchema = z.object({
  server: z.object({ port: z.number().int().positive().default(8080) }).default({ port: 8080 }),
  database: z.object({ path: z.string().min(1) }),
  trashDir: z.string().min(1),
  plugins: z.record(z.string(), z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))),
  downloadClients: z.array(downloadClientSchema).min(1),
  feeds: z.array(feedSchema).min(1),
});

export type PickarrConfig = z.infer<typeof configSchema>;
export type DownloadClientConfig = z.infer<typeof downloadClientSchema>;
export type FeedConfig = z.infer<typeof feedSchema>;
export type PathMapping = z.infer<typeof pathMappingSchema>;
