import type { SkillInfo, SkillDetail } from '@macaron/shared';
export declare function listSkills(): Promise<SkillInfo[]>;
export declare function readSkillDetail(dir: string): Promise<SkillDetail | null>;
export declare function setSkillEnabled(dir: string, enabled: boolean): Promise<boolean>;
export type CreateSkillInput = {
    name: string;
    description: string;
    body?: string;
};
export declare function createSkill(input: CreateSkillInput): Promise<{
    dir: string;
} | {
    error: string;
}>;
//# sourceMappingURL=skills-store.d.ts.map