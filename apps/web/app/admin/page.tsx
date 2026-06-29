'use client';

export default function AdminHome() {
  return (
    <div>
      <div className="topbar">
        <h1>Reference data</h1>
      </div>
      <p className="muted">
        Pick a table from the left to browse, search, add, edit or delete records. All data was
        imported from the Quote Base workbook.
      </p>
    </div>
  );
}
