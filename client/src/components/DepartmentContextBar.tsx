import type { DepartmentMembership } from '../api/authTypes';
import { Select } from './Field';
import { Card } from './Card';

export function DepartmentContextBar({
  memberships,
  selectedDepartmentId,
  onChange,
}: {
  memberships: DepartmentMembership[];
  selectedDepartmentId: string;
  onChange: (departmentId: string) => void;
}) {
  const selected = memberships.find((membership) => membership.departmentId === selectedDepartmentId);
  return (
    <Card className="mb-8 bg-surface-1">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-[0.75rem] tracking-[0.02em] text-ink-muted">Department context</p>
          <p className="mt-1 text-[1.125rem] font-semibold">
            {selected?.departmentName ?? selected?.departmentId ?? 'Department unavailable'}
          </p>
          {selected && <p className="mt-1 text-[0.875rem] text-ink-muted">Membership: {selected.role}</p>}
        </div>
        {memberships.length > 1 && (
          <Select
            label="Choose department"
            value={selectedDepartmentId}
            onChange={(event) => onChange(event.target.value)}
            className="md:max-w-xs"
          >
            {memberships.map((membership) => (
              <option key={membership.departmentId} value={membership.departmentId}>
                {membership.departmentName ?? membership.departmentId}
              </option>
            ))}
          </Select>
        )}
      </div>
    </Card>
  );
}
