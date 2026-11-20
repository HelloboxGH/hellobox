"use client";

import { Segmented } from "@/components/segmented";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";

const HOURS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export interface TimeValue {
  hour: number;
  minute: number;
  period: "am" | "pm";
}

export const to24Hour = ({ hour, period }: TimeValue) =>
  (hour % 12) + (period === "pm" ? 12 : 0);

export function TimePicker({
  value, onChange, isHourPast,
}: {
  value: TimeValue;
  onChange: (value: TimeValue) => void;
  isHourPast: (hour24: number) => boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-sm">Hour</span>
        <Segmented
          label="AM or PM"
          value={value.period}
          onChange={(period) => onChange({ ...value, period })}
          options={[{ value: "am", label: "AM" }, { value: "pm", label: "PM" }]}
        />
      </div>
      <div role="group" aria-label="Hour" className="grid grid-cols-4 gap-2">
        {HOURS.map((hour) => {
          const selected = value.hour === hour;
          return (
            <Button
              key={hour}
              aria-pressed={selected}
              disabled={isHourPast(to24Hour({ ...value, hour }))}
              onClick={() => onChange({ ...value, hour })}
              variant={selected ? "default" : "secondary"}
              className="aspect-square h-auto rounded-xl text-base tabular-nums sm:h-auto"
            >
              {hour}
            </Button>
          );
        })}
      </div>
      <Separator />
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-sm">Minute</span>
        <Input
          aria-label="Minute"
          inputMode="numeric"
          className="w-16 text-center tabular-nums"
          value={String(value.minute)}
          onChange={(event) => {
            const minute = Number(event.target.value.replace(/\D/g, "") || 0);
            onChange({ ...value, minute: Math.min(minute, 59) });
          }}
        />
      </div>
      <Slider
        aria-label="Minute"
        min={0}
        max={59}
        value={value.minute}
        onValueChange={(minute) => onChange({ ...value, minute: Array.isArray(minute) ? (minute[0] ?? 0) : minute })}
      />
    </div>
  );
}
