import { z } from 'zod';
import { isCountry } from './places';

// Request and storage validation: server-side only, so the validation library stays out of the browser bundle.
const text = (max: number) => z.string().trim().max(max);
export const registrationEmail = z.string().trim().toLowerCase().max(254).pipe(z.email());
export const searchSchema = z.object({
  mode: z.enum(['people', 'companies']).default('people'), // people inside companies, or the companies' own emails
  sector: text(60).min(2), // a listed sector, or the member's own words
  countries: z.array(z.string().refine(isCountry)).min(1).max(10),
  city: text(60).default(''),
  title: text(60).default(''), // a listed title, English as typed, or Arabic words for the AI
  size: z.enum(['all', '1-10', '11-50', '51-200']).default('all'),
  count: z.number().int().min(1).max(50),
  widen: z.boolean().default(true), // short of the count: the whole country, then the region's other countries (live-search.ts placesOf)
  confirmed: z.literal(true),
  requestId: z.string().uuid(),
});
export type SearchInput = z.infer<typeof searchSchema>;
// A search as stored and run: the form plus the provider names it resolved to (server-side only, never from the client).
export const resolvedSchema = searchSchema.extend({
  industries: z.array(text(120)).min(1).max(40), industryLabels: z.array(text(80)).max(40), titles: z.array(text(80)).max(40),
});
export type Resolved = z.infer<typeof resolvedSchema>;

export const weekBoundariesSchema = z.array(z.iso.datetime()).length(8).refine(days =>
  days.every((day, index) => {
    if (index === 0) return true;
    const hours = (Date.parse(day) - Date.parse(days[index - 1])) / 3600000;
    return hours >= 20 && hours <= 28;
  }), 'Expected seven consecutive calendar days',
);

export const assistRequestSchema = z.object({
  messages: z.array(z.object({role:z.enum(['user','assistant']),content:text(1200).min(1)})).min(1).max(8),
  context: searchSchema.omit({confirmed:true,requestId:true}).extend({sector:text(60)}).optional(),
});
