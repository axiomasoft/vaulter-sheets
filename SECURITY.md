# Security policy

Vaulter Sheets is a proprietary package set distributed through a private channel. Security
fixes target `main` and are shipped in the next private release.

Report vulnerabilities privately to Dmitry Vostrikov at **dv.vostrikov@gmail.com**. Do not put
credentials, personal data, exploit details or customer workbooks in issues. Send a minimal
redacted reproduction (for import issues, a synthetic XLSX or CSV file that triggers the
problem), the affected package and version, and the impact.

Particularly relevant areas are:

- the XLSX/CSV import path: ZIP and XML parsing, entry and size quotas, relationship parts and
  external targets;
- the Node workbook runtime: its bearer token, the wire schema between PHP and Node, and
  formula evaluation of untrusted workbooks;
- the realtime room: room credentials, the private owner endpoint and its token, and the
  journal replay;
- authorization of the `/api/vaulter-sheets/v1` endpoints and the handling of stored blobs.

Target acknowledgement is within three working days and an initial assessment within ten
working days. These are response targets, not guaranteed remediation deadlines.

Please test only systems you own or are allowed to assess, minimize data access, and stop if
customer data is exposed.
