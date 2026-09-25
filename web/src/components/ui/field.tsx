import * as React from "react";

// A labelled form field publishes its control id here so composite controls
// (Select triggers, date-picker buttons) can take the id their <label htmlFor>
// points at, instead of the id being dropped on a non-DOM root component.
const FieldControlIdContext = React.createContext<string | undefined>(undefined);

function FieldControlIdProvider({ id, children }: { id: string | undefined; children: React.ReactNode }) {
  return <FieldControlIdContext.Provider value={id}>{children}</FieldControlIdContext.Provider>;
}

function useFieldControlId() {
  return React.useContext(FieldControlIdContext);
}

export { FieldControlIdProvider, useFieldControlId };
