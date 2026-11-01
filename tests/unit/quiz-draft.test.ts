import { describe, expect, it } from 'vitest';
import { draftSchema, expireDraft } from '../../src/client/draft';
import { contextSchema, identityResponseSchema, quizResultSchema } from '../../src/shared/quiz';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const draft={version:1 as const,user:id(1),preland:'demo' as const,deadline:100,phase:'a' as const,entry:id(2),a:id(3),b:id(4),view:id(5),email:'Synthetic@example.test'};
describe('versioned final recovery draft',()=>{
  it('requires valid normalized email and A/view links before A',()=>{
    expect(draftSchema.safeParse(draft).success).toBe(true);
    for(const patch of [{email:'bad'},{email:'Synthetic@EXAMPLE.TEST'},{view:undefined},{a:undefined},{a:draft.b},{extra:true},{version:2},{deadline:-1}])expect(draftSchema.safeParse({...draft,...patch}).success).toBe(false);
  });
  it('rejects email or view payload in b/done/expired phases',()=>{
    for(const phase of ['b','done','expired']){
      expect(draftSchema.safeParse({...draft,phase}).success).toBe(false);
      expect(draftSchema.safeParse({...draft,phase,email:undefined,view:undefined}).success).toBe(true);
    }
  });
  it('exact deadline drops payload but preserves minimal read keys',()=>{
    expect(expireDraft(draft,99)).toBe(draft);
    const expired=expireDraft(draft,100);expect(expired).toMatchObject({phase:'expired',a:draft.a,b:draft.b,entry:draft.entry,deadline:100});
    expect(expired.email).toBeUndefined();expect(expired.view).toBeUndefined();expect(draftSchema.safeParse(expired).success).toBe(true);
  });
  it('shared response schemas reject corrupt/unknown DTOs',()=>{
    expect(contextSchema.safeParse({identity_status:'missing',server_time:1}).success).toBe(true);
    expect(contextSchema.safeParse({identity_status:'ready',server_time:1,user_id:id(1),answers:{},next_action:'quiz'}).success).toBe(true);
    expect(contextSchema.safeParse({identity_status:'missing',server_time:1,email:'private@example.test'}).success).toBe(false);
    expect(identityResponseSchema.safeParse({user_id:'invalid'}).success).toBe(false);
    expect(quizResultSchema.safeParse({code:'accepted'}).success).toBe(false);
    expect(quizResultSchema.safeParse({code:'no_offer',catalog_version:'a'.repeat(64)}).success).toBe(true);
  });
});
