SERVICE = cal
COMMIT_SHA = $(shell git rev-parse HEAD)
IMAGE = ${AWS_ECR_URL}/tourlane/${SERVICE}:${COMMIT_SHA}

SSM_STAGING = /${SERVICE}/staging
SSM_PRODUCTION = /${SERVICE}/production
SSM_SHARED = /${SERVICE}/shared

FUJI=docker run --rm -t \
		 -e AWS_DEFAULT_REGION="eu-west-1" \
		 -e AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID}" \
		 -e AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY}" \
		 ${AWS_ECR_URL}/fuji:2.0.1

.PHONY: docker_build
docker_build:
	docker build \
	       --network host \
	       --build-arg DATABASE_URL=${DATABASE_URL} \
	       --build-arg 'GOOGLE_API_CREDENTIALS=${GOOGLE_API_CREDENTIALS}' \
	       --build-arg NEXT_PUBLIC_WEBAPP_URL=${NEXT_PUBLIC_WEBAPP_URL} \
	       --build-arg NEXT_PUBLIC_SLOTS_PROXY_URL=${NEXT_PUBLIC_SLOTS_PROXY_URL} \
	       --build-arg GLOBAL_WEBHOOK_URL=${GLOBAL_WEBHOOK_URL} \
	       -t ${IMAGE} .

.PHONY: docker_push
docker_push:
	docker push ${IMAGE}

.PHONY: deploy_to_staging
deploy_to_staging:
	@echo "\033[94m## Deploying ${COMMIT_SHA} to staging \033[0m"
	@${FUJI} deploy \
		--service ${SERVICE} \
		--branch staging \
		--cluster staging \
		--environment NEXT_PUBLIC_WEBAPP_URL=${NEXT_PUBLIC_WEBAPP_URL},GOOGLE_LOGIN_ENABLED=true,NEXT_PUBLIC_SLOTS_PROXY_URL=${NEXT_PUBLIC_SLOTS_PROXY_URL},GLOBAL_WEBHOOK_URL=${GLOBAL_WEBHOOK_URL} \
		--secrets DATABASE_URL=${SSM_STAGING}/DATABASE_URL,NEXTAUTH_SECRET=${SSM_STAGING}/NEXTAUTH_SECRET,CALENDSO_ENCRYPTION_KEY=${SSM_STAGING}/CALENDSO_ENCRYPTION_KEY,GOOGLE_API_CREDENTIALS=${SSM_SHARED}/GOOGLE_API_CREDENTIALS \
		--image ${IMAGE} \
		--command "sh /calcom/scripts/start.sh" \
		--desired-count "1" \
		--memory-reservation 512 \
		--memory 1024 \
		--port "3000"

.PHONY: deploy_to_production
deploy_to_production:
	@echo "\033[94m## Deploying ${COMMIT_SHA} to production \033[0m"
	@${FUJI} deploy \
		--service ${SERVICE} \
		--branch master \
		--cluster production \
		--environment NEXT_PUBLIC_WEBAPP_URL=${NEXT_PUBLIC_WEBAPP_URL},GOOGLE_LOGIN_ENABLED=true,NEXT_PUBLIC_SLOTS_PROXY_URL=${NEXT_PUBLIC_SLOTS_PROXY_URL},GLOBAL_WEBHOOK_URL=${GLOBAL_WEBHOOK_URL} \
		--secrets DATABASE_URL=${SSM_PRODUCTION}/DATABASE_URL,NEXTAUTH_SECRET=${SSM_PRODUCTION}/NEXTAUTH_SECRET,CALENDSO_ENCRYPTION_KEY=${SSM_PRODUCTION}/CALENDSO_ENCRYPTION_KEY,GOOGLE_API_CREDENTIALS=${SSM_SHARED}/GOOGLE_API_CREDENTIALS \
		--image ${IMAGE} \
		--command "sh /calcom/scripts/start.sh" \
		--desired-count "4" \
		--memory-reservation 1024 \
		--memory 2048 \
		--port "3000"

