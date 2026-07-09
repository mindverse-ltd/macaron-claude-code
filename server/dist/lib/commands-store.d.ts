import type { SavedCommand } from '@macaron/shared';
export declare function isValidName(name: string): boolean;
export declare function listCommands(): Promise<SavedCommand[]>;
export declare function getCommand(name: string): Promise<SavedCommand | null>;
export type CommandInput = {
    description?: string;
    argumentHint?: string;
    body: string;
};
export declare function createCommand(name: string, input: CommandInput): Promise<SavedCommand>;
export declare function updateCommand(name: string, input: CommandInput): Promise<SavedCommand | null>;
export declare function deleteCommand(name: string): Promise<boolean>;
//# sourceMappingURL=commands-store.d.ts.map