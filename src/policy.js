// Single source of truth for authorization + workflow rules.
// Used by the service to ENFORCE, and by the API to tell the UI what is allowed.
const RANK = { viewer: 0, member: 1, lead: 2, admin: 3 };
const atLeast = (role, min) => role != null && RANK[role] >= RANK[min];
const STATUSES = ['open', 'in_progress', 'pending_approval', 'resolved', 'closed'];
const ACTIVE = ['open', 'in_progress'];
const isActive = (s) => ACTIVE.includes(s);
const ownerish = (i, u) => i.assignee_id === u || i.creator_id === u;

function canEdit(i, u, r) {
  return isActive(i.status) && (atLeast(r, 'lead') || (atLeast(r, 'member') && ownerish(i, u)));
}
function canSetPriority(i, u, r, p) {
  if (!(isActive(i.status) || i.status === 'pending_approval')) return false;
  if (p === 4 && !atLeast(r, 'lead')) return false; // urgent is a lead decision
  return atLeast(r, 'lead') || (atLeast(r, 'member') && ownerish(i, u));
}
const canClaim = (i, u, r) => atLeast(r, 'member') && i.status === 'open' && i.assignee_id == null;
const canRelease = (i, u, r) => i.assignee_id != null && isActive(i.status) && (i.assignee_id === u || atLeast(r, 'lead'));
const canAssign = (i, u, r) => atLeast(r, 'lead') && isActive(i.status);
const canComment = (i, u, r) => atLeast(r, 'member');

// returns null when allowed, otherwise a human-readable reason
function checkTransition(i, u, r, to) {
  const isAssignee = i.assignee_id === u, lead = atLeast(r, 'lead'), member = atLeast(r, 'member');
  switch (`${i.status}>${to}`) {
    case 'open>in_progress':
      if (!i.assignee_id) return 'Item needs an owner first';
      return isAssignee || lead ? null : 'Only the owner or a lead can start work';
    case 'in_progress>pending_approval':
      if (!i.requires_approval) return 'This item does not require approval';
      return isAssignee || lead ? null : 'Only the owner or a lead can request approval';
    case 'in_progress>resolved':
      if (i.requires_approval) return 'Approval is required before resolving';
      return isAssignee || lead ? null : 'Only the owner or a lead can resolve';
    case 'pending_approval>resolved':
      if (!lead) return 'Only leads can approve';
      if (isAssignee) return 'You cannot approve your own work'; // separation of duties
      return null;
    case 'pending_approval>in_progress': return lead ? null : 'Only leads can reject';
    case 'resolved>closed': return lead || i.creator_id === u ? null : 'Only a lead or the creator can close';
    case 'resolved>open': return member ? null : 'Viewers cannot reopen';
    case 'closed>open': return lead ? null : 'Only leads can reopen closed items';
    default: return `Invalid transition ${i.status} → ${to}`;
  }
}

function allowed(i, u, r) {
  return {
    edit: canEdit(i, u, r),
    setPriority: canSetPriority(i, u, r, 3),
    setUrgent: canSetPriority(i, u, r, 4),
    claim: canClaim(i, u, r),
    release: canRelease(i, u, r),
    assign: canAssign(i, u, r),
    comment: canComment(i, u, r),
    transitions: STATUSES.filter((to) => checkTransition(i, u, r, to) === null),
  };
}

module.exports = { RANK, atLeast, STATUSES, ACTIVE, isActive, canEdit, canSetPriority, canClaim, canRelease, canAssign, canComment, checkTransition, allowed };
