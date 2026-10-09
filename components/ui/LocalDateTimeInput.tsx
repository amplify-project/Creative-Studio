"use client";

import { useState } from "react";

/**
 * A `datetime-local` field that submits an absolute instant.
 *
 * `datetime-local` gives a wall-clock string with no zone ("2026-10-09T18:00").
 * Parsed on the server, `new Date()` reads it in the SERVER's zone — UTC in
 * Docker — so a host in Spain who picked 18:00 got an event at 20:00 their
 * time. Only the browser knows which zone the host meant, so the conversion
 * happens here: the visible field has no name, and a hidden field `name`
 * carries the same moment as an ISO string in UTC ("…Z").
 */
export default function LocalDateTimeInput({
  name,
  required,
  className,
}: {
  name: string;
  required?: boolean;
  className?: string;
}) {
  const [iso, setIso] = useState("");
  return (
    <>
      <input
        className={className}
        type="datetime-local"
        required={required}
        onChange={(e) => {
          const d = e.target.value ? new Date(e.target.value) : null;
          setIso(d && !Number.isNaN(d.getTime()) ? d.toISOString() : "");
        }}
      />
      <input type="hidden" name={name} value={iso} />
    </>
  );
}
