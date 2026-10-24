import { Link } from 'react-router';
import { Card } from '../components/Card';
import { Notification } from '../components/Notification';
import { Page } from '../components/Layout';

export function UnsupportedWorkflowPage({
  title,
  intro,
  capability,
  explanation,
  backTo,
  backLabel,
}: {
  title: string;
  intro: string;
  capability: string;
  explanation: string;
  backTo?: string;
  backLabel?: string;
}) {
  return (
    <Page title={title} intro={intro}>
      <Card className="max-w-2xl">
        <Notification kind="info" title={`${capability} is not available yet`}>
          <p>{explanation}</p>
          <p className="mt-3">No AI result, review decision, upload, resolution, verification, or dispute outcome is being simulated here.</p>
        </Notification>
        {backTo && backLabel && (
          <Link to={backTo} className="mt-5 inline-flex min-h-12 items-center text-primary">
            ← {backLabel}
          </Link>
        )}
      </Card>
    </Page>
  );
}
