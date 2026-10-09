export interface UnitMetadata {
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

export function isZoneMessage(message: unknown): boolean;
export function convertAlertMessage(
  message: string | undefined,
  metadata?: UnitMetadata,
  value?: number,
): string | undefined;
