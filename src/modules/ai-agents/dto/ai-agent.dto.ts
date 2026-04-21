import { IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateAiAgentDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsIn(['sales', 'support', 'receptionist', 'custom'])
  agentType: 'sales' | 'support' | 'receptionist' | 'custom';

  @IsOptional()
  @IsString()
  tone?: string;

  @IsOptional()
  @IsString()
  defaultLanguage?: string;

  @IsOptional()
  @IsArray()
  channelAllowlist?: string[];

  @IsOptional()
  @IsObject()
  llmConfig?: Record<string, any>;

  @IsOptional()
  @IsObject()
  runtimeConfig?: Record<string, any>;

  @IsOptional()
  @IsObject()
  guardrails?: Record<string, any>;

  @IsOptional()
  @IsArray()
  toolsAllowed?: string[];

  @IsOptional()
  @IsArray()
  knowledgeSourceIds?: string[];

  @IsOptional()
  @IsString()
  systemPrompt?: string;
}

export class UpdateAiAgentDraftDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  tone?: string;

  @IsOptional()
  @IsString()
  defaultLanguage?: string;

  @IsOptional()
  @IsArray()
  channelAllowlist?: string[];

  @IsOptional()
  @IsObject()
  businessHours?: Record<string, any>;

  @IsOptional()
  @IsObject()
  llmConfig?: Record<string, any>;

  @IsOptional()
  @IsObject()
  runtimeConfig?: Record<string, any>;

  @IsOptional()
  @IsObject()
  guardrails?: Record<string, any>;

  @IsOptional()
  @IsArray()
  toolsAllowed?: string[];

  @IsOptional()
  @IsArray()
  knowledgeSourceIds?: string[];

  @IsOptional()
  @IsString()
  systemPrompt?: string;

  @IsOptional()
  @IsIn(['off', 'first_reply', 'all_replies', 'tools_only'])
  approvalMode?: 'off' | 'first_reply' | 'all_replies' | 'tools_only';

  @IsOptional()
  @IsBoolean()
  sandboxMode?: boolean;
}

export class CreateKnowledgeSourceDto {
  @IsString()
  name: string;

  @IsIn(['file', 'website', 'faq', 'product_catalog', 'manual'])
  sourceType: 'file' | 'website' | 'faq' | 'product_catalog' | 'manual';

  @IsOptional()
  @IsString()
  uri?: string;

  @IsOptional()
  @IsUUID()
  fileAssetId?: string;

  @IsOptional()
  @IsObject()
  crawlerConfig?: Record<string, any>;

  @IsOptional()
  @IsObject()
  importConfig?: Record<string, any>;
}

export class SandboxRunDto {
  @IsUUID()
  conversationId: string;

  @IsString()
  message: string;
}

export class FeedbackDto {
  @IsOptional()
  @IsUUID()
  runId?: string;

  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @IsOptional()
  @IsUUID()
  messageId?: string;

  @IsOptional()
  rating?: number;

  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsString()
  comment?: string;
}
