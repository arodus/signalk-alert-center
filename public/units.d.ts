export interface GeneratedZone {
  name: string;
  lower?: number;
  upper?: number;
}
export interface UnitMetadata {
  path?: string;
  displayName?: string;
  zones?: { lower?: number; upper?: number; message?: string }[];
  generatedZone?: GeneratedZone;
  units?: string;
  displayUnits?: {
    category?: string;
    formula?: string;
    symbol?: string;
    targetUnit?: string;
  };
}
export function convertDisplayValue(formula: string, value: number): number;
export function displayZone(
  zone: { lower?: number; upper?: number },
  metadata?: UnitMetadata,
): { zone: { lower?: number; upper?: number }; units?: string };

export function generatedZoneMessage(
  message: unknown,
  metadata?: UnitMetadata,
): GeneratedZone | undefined;
export function isZoneMessage(
  message: unknown,
  metadata?: UnitMetadata,
): boolean;
export function convertAlertMessage(
  message: string | undefined,
  metadata?: UnitMetadata,
  value?: number,
): string | undefined;
