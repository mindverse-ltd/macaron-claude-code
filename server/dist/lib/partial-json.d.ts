/**
 * Extracts the in-progress value of a string field from an incomplete JSON
 * blob. Returns '' if the field hasn't started yet. Handles common JSON
 * escape sequences so the renderer gets valid text.
 *
 * Example: `{"code":"import {Bu` → `import {Bu`
 */
export declare function extractPartialCode(raw: string, field?: string): string;
//# sourceMappingURL=partial-json.d.ts.map