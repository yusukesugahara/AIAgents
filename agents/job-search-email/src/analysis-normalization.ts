import type { JobEmailAnalysis } from './schemas';

/**
 * A scheduling request from a recruiter needs a response even when the model
 * accidentally marks it as informational. This protects against silently
 * skipping the editable scheduling Draft workflow.
 */
export function normalizeJobEmailAnalysis(analysis: JobEmailAnalysis): JobEmailAnalysis {
  if (analysis.category !== 'scheduling_request' || analysis.needsReply) return analysis;
  return {
    ...analysis,
    needsReply: true,
    replyIntent: 'submit_information',
  };
}
