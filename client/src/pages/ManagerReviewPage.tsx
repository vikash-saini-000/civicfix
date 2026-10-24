import { useParams } from 'react-router';
import { UnsupportedWorkflowPage } from './UnsupportedWorkflowPage';

export function ManagerReviewPage() {
  return (
    <UnsupportedWorkflowPage
      title="Manager review"
      intro="Review queue and AI-assisted recommendations require a verified backend contract."
      capability="Manager review queue"
      explanation="This repository documents proposed AI-analysis and manager-decision endpoints, but no implemented queue, analysis response, review state, decision enum, or authorization contract exists yet."
      backTo="/department"
      backLabel="Back to department workspace"
    />
  );
}

export function ManagerReviewDetailPage() {
  const { complaintId = '' } = useParams<{ complaintId?: string }>();
  return (
    <UnsupportedWorkflowPage
      title="Manager review detail"
      intro={complaintId ? `Review details for ${complaintId} are not available in the current backend contract.` : 'Review details are not available in the current backend contract.'}
      capability="AI analysis and human review"
      explanation="The frontend does not display fabricated classifications, confidence values, duplicate candidates, media signals, review history, or decision actions."
      backTo="/manager/review"
      backLabel="Back to manager review"
    />
  );
}
