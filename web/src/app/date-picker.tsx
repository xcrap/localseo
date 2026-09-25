import { CalendarDays } from "lucide-react";
import { Button, Popover, PopoverContent, PopoverTrigger, useFieldControlId } from "@/components/ui";
import { Calendar } from "@/components/ui/calendar";
import { Field, formatDateInput, formatDateLabel, parseDateInput } from "./shared";

// Date pickers for Search Console style ranges. Only the pages that import this
// module pull in the calendar library, so it stays out of the shared bundle.
export function DatePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const fieldId = useFieldControlId();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button id={fieldId} type="button" variant="outline" className="w-full justify-start text-left font-normal">
          <CalendarDays className="size-4" />
          {formatDateLabel(value)}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-3">
        <Calendar
          mode="single"
          selected={parseDateInput(value)}
          onSelect={(date) => date && onChange(formatDateInput(date))}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  );
}

export type DateRange = { startDate: string; endDate: string };

/** The `days`-long window ending `endOffsetDays` before today, as YYYY-MM-DD. */
export function recentDateRange(days: number, endOffsetDays = 0): DateRange {
  const end = new Date();
  end.setDate(end.getDate() - endOffsetDays);
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  return { startDate: formatDateInput(start), endDate: formatDateInput(end) };
}

export function DateRangeFields({
  value,
  onChange,
  startLabel = "Start date",
  endLabel = "End date",
}: {
  value: DateRange;
  onChange: (value: DateRange) => void;
  startLabel?: string;
  endLabel?: string;
}) {
  return (
    <>
      <Field label={startLabel}>
        <DatePicker value={value.startDate} onChange={(startDate) => onChange({ ...value, startDate })} />
      </Field>
      <Field label={endLabel}>
        <DatePicker value={value.endDate} onChange={(endDate) => onChange({ ...value, endDate })} />
      </Field>
    </>
  );
}
