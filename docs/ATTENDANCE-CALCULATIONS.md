# Attendance calculations

For a pupil:

```text
attendance percentage = actual present sessions / eligible possible sessions * 100
```

Late counts as an attended session. The eligible denominator is built from actual school days, two register slots per day, the official session/term, the Central Registry calendar contract (`school_day`, `holiday`, `closure`, `special_event`, `exam_day`, and `staff_only`), admission date and the valid pupil roster. Calendar rows that do not require student attendance are excluded.

Missing or incomplete rows are not counted as present. They are reported separately so an unconfirmed register is not confused with absence.

The same aggregation produces daily, weekly, monthly, term and session reports, including grouped weekly and monthly period rows. Percentages are rounded to two decimal places for display. Stored event times remain unrounded; rounding occurs only at presentation.

Class percentage is the sum of actual eligible pupil sessions divided by the sum of possible eligible pupil sessions. School closures and not-expected sessions are excluded from both numerator and denominator.
