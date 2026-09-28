-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('owner', 'admin', 'editor', 'viewer');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('queued', 'running', 'awaiting_approval', 'completed', 'failed', 'canceled', 'needs_review');

-- CreateEnum
CREATE TYPE "JobStage" AS ENUM ('moderation', 'story', 'characters', 'keyframes', 'video', 'audio', 'edit', 'final');

-- CreateEnum
CREATE TYPE "SceneStatus" AS ENUM ('pending', 'keyframes', 'video', 'audio', 'done', 'failed', 'fallback');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'editor',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("workspace_id","user_id")
);

-- CreateTable
CREATE TABLE "video_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'queued',
    "current_stage" "JobStage",
    "input" JSONB NOT NULL,
    "pipeline_version" TEXT NOT NULL DEFAULT 'v0',
    "temporal_workflow_id" TEXT,
    "title" TEXT,
    "duration_sec" DOUBLE PRECISION,
    "scene_count" INTEGER,
    "estimated_credits" INTEGER NOT NULL,
    "actual_credits" INTEGER,
    "credits_held" INTEGER NOT NULL DEFAULT 0,
    "output" JSONB,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "error" JSONB,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenes" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "idx" INTEGER NOT NULL,
    "status" "SceneStatus" NOT NULL DEFAULT 'pending',
    "plan" JSONB,
    "planned_sec" DOUBLE PRECISION,
    "actual_sec" DOUBLE PRECISION,
    "attempts" JSONB NOT NULL DEFAULT '{}',
    "provider_video" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scenes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artifacts" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "scene_index" INTEGER,
    "kind" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "content_type" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_events" (
    "id" BIGSERIAL NOT NULL,
    "job_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_external_id_key" ON "users"("external_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "video_jobs_temporal_workflow_id_key" ON "video_jobs"("temporal_workflow_id");

-- CreateIndex
CREATE INDEX "video_jobs_workspace_id_created_at_idx" ON "video_jobs"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "video_jobs_status_idx" ON "video_jobs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "scenes_job_id_idx_key" ON "scenes"("job_id", "idx");

-- CreateIndex
CREATE INDEX "artifacts_job_id_kind_idx" ON "artifacts"("job_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "artifacts_job_id_storage_key_key" ON "artifacts"("job_id", "storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "job_events_job_id_seq_key" ON "job_events"("job_id", "seq");

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_jobs" ADD CONSTRAINT "video_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_jobs" ADD CONSTRAINT "video_jobs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "video_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "video_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "video_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
