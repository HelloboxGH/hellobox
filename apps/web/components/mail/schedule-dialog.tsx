"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle,
} from "@/components/ui/dialog";
import { TimePicker, type TimeValue, to24Hour } from "./time-picker";

const atTime = (day: Date, hour: number, minute: number) => {
  const date = new Date(day);
  date.setHours(hour, minute, 0, 0);
  return date;
};

export function ScheduleDialog({
  onClose, onSchedule,
}: {
  onClose: () => void;
  onSchedule: (date: Date) => void;
}) {
  const [now] = useState(() => new Date());
  const [today] = useState(() => atTime(now, 0, 0));
  const [day, setDay] = useState(() => {
    const date = new Date(today);
    date.setDate(date.getDate() + 1);
    return date;
  });
  const [time, setTime] = useState<TimeValue>({ hour: 9, minute: 0, period: "am" });

  const sendAt = atTime(day, to24Hour(time), time.minute);
  const inFuture = sendAt > now;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Pick a date and time</DialogTitle>
          <DialogDescription>Times are in your time zone, {zone.replace(/_/g, " ")}.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid items-start gap-6 sm:grid-cols-[auto_1fr]">
          <Calendar
            mode="single"
            required
            className="mx-auto"
            selected={day}
            defaultMonth={day}
            disabled={{ before: today }}
            onSelect={(date: Date | undefined) => { if (date) setDay(date); }}
          />
          <TimePicker
            value={time}
            onChange={setTime}
            isHourPast={(hour24) => atTime(day, hour24, 59) <= now}
          />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button disabled={!inFuture} onClick={() => onSchedule(sendAt)}>
            {inFuture
              ? `Schedule for ${sendAt.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${sendAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
              : "Pick a time in the future"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
