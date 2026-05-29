import { shortNameOf, type OrgMember } from '../hooks/useOrgMembers';

interface Props {
  createdBy: string | null;
  myUserId: string | null;
  membersById: Map<string, OrgMember>;
}

/**
 * 车源上传人徽标。自己上传的显示绿色「我上传」，别人的显示销售 shortName。
 * created_by 为空（历史未回填）则不渲染。
 */
export function UploaderBadge({ createdBy, myUserId, membersById }: Props) {
  if (!createdBy) return null;
  const mine = createdBy === myUserId;
  const name = mine ? '我上传' : shortNameOf(membersById.get(createdBy));
  return (
    <span
      className={`sgc-uploader-badge${mine ? ' mine' : ''}`}
      title={mine ? '我上传的车源' : `${name} 上传`}
    >
      👤 {name}
    </span>
  );
}
