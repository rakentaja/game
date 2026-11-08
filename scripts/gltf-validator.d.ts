declare module 'gltf-validator' {
  export interface ValidatorMessage {
    code: string;
    message: string;
    severity: 0 | 1 | 2 | 3;
    pointer?: string;
  }
  export interface ValidatorReport {
    issues: { numErrors: number; numWarnings: number; messages: ValidatorMessage[] };
  }
  export function validateBytes(data: Uint8Array, options?: { maxIssues?: number }): Promise<ValidatorReport>;
  export const version: string;
}
