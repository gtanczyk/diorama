/** Milestones for an extension job; a place build can repeat its steps several times. */
export type ExtensionProgress = {
  phase: 'plan' | 'places' | 'audio' | 'install';
  place?: string;
  index?: number;
  total?: number;
  task?: 'characters';
  /** New place keys are provisional until the staged extension is installed. */
  newPlaces?: string[];
};
