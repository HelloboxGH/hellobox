"use client";

import { type Accent, ACCENTS, setAccent, useAccent } from "@/components/theme";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";

export function AccentPicker() {
  const accent = useAccent();
  return (
    <RadioGroup
      aria-label="Accent color"
      value={accent}
      onValueChange={(value) => setAccent(value as Accent)}
      className="flex flex-row flex-wrap gap-3 p-0.5"
    >
      {ACCENTS.map((item) => (
        <Tooltip key={item.value}>
          <TooltipTrigger
            render={
              <Radio
                aria-label={item.label}
                value={item.value}
                style={{ backgroundColor: item.color }}
                className="size-7! rounded-full border-transparent ring-offset-2 ring-offset-card transition-transform hover:scale-105 data-checked:ring-2 data-checked:ring-foreground [&>span]:hidden"
              />
            }
          />
          <TooltipPopup>{item.label}</TooltipPopup>
        </Tooltip>
      ))}
    </RadioGroup>
  );
}
