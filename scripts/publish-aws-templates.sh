#!/usr/bin/env sh
# Uploads the customer CloudFormation templates to the broker's templates bucket.
# Run with the hellobox-template-publisher user's keys in the AWS CLI environment:
#   AWS_TEMPLATES_BUCKET=hellobox-templates-<account> scripts/publish-aws-templates.sh
set -eu

: "${AWS_TEMPLATES_BUCKET:?Set AWS_TEMPLATES_BUCKET to the broker stack's TemplatesBucket output}"
dir="$(cd "$(dirname "$0")/.." && pwd)/infra/aws"

aws cloudformation validate-template --template-body "file://$dir/connect.yaml" >/dev/null
aws s3 cp "$dir/connect.yaml" "s3://$AWS_TEMPLATES_BUCKET/templates/connect.yaml" \
  --content-type text/yaml --cache-control "max-age=300"
echo "Published connect.yaml to s3://$AWS_TEMPLATES_BUCKET/templates/"
