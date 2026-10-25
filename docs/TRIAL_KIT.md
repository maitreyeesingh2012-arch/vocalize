# Vocalize user trial kit (2–3 weeks)

## Steps for each tester
1. Open the live link, tap **Begin singing as a guest** (or create an account), confirm age 13+.
2. **Day 1, baseline:** record the same 30–60 second song excerpt. Note which excerpt.
3. **Days 2–13:** follow the 7-day plan on the Today screen (about 15 minutes, 4+ days a week).
4. **Last day:** record the same excerpt again, in a similar room with the same device.
5. Fill in the survey below.

Under-18 testers: get a parent's OK first; they can delete their data any time under Profile.

## Numbers to report (run at the end)
```powershell
.\.venv\Scripts\python.exe scripts\usage_report.py --since <trial start date> --out docs\usage.md
```
Report: active singers, sessions, practice-tool uses, first-vs-last change in overall and pitch
accuracy, and how many singers improved. Always state the number of singers next to an average.

## Survey (5 questions; a Google Form works)
1. How useful was Vocalize's feedback? (1 = not at all, 5 = very)
2. Which feature helped most? (report / pitch map / tuner / warm-ups / pitch matching / range / breath / plan)
3. Did you practise more often than usual during the trial? (less / same / more)
4. Was anything confusing or wrong? (free text)
5. May we quote you, and how should we name you? (e.g. "Alto, West High choir")

## Teacher rating sheet (for the accuracy study)
Ask a voice teacher to rate 10–20 takes **without seeing Vocalize's scores**, 1–5 for each:

| Take | Pitch accuracy | Pitch stability | Breath support | Tone | Notes |
|---|---|---|---|---|---|
| 1 | | | | | |

Then compare with Vocalize's scores for the same takes (Spearman correlation in a spreadsheet:
`=CORREL(RANK(...), RANK(...))`, or ask for help computing it). Report the correlation and the
number of takes, and be honest if agreement is weak; that's a real finding.

## Teacher quote via share link
On a session report: **Share → Create link** (tick "Include the recording"), send the link to
the teacher, and ask for two sentences on whether the report matches what they hear.
