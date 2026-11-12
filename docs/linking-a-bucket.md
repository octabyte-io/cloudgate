# Linking a bucket

A **Bucket** is a Service that holds files and runs nothing of its own, written `kind: bucket` in the Project config. A Service reaches it by **linking** its Outputs to its own variables, the way it links a database's `url` ([Linking a database](linking-a-database.md), ADR-0031). The same config works on a Server and on AWS (ADR-0032):

```yaml
version: 1
services:
  uploads:
    kind: bucket
  web:
    kind: web
    source:
      github: acme/shop
    env:
      - S3_BUCKET: uploads.name
      - AWS_REGION: uploads.region
      - S3_ENDPOINT: uploads.endpoint
      - S3_FORCE_PATH_STYLE: uploads.path_style
      - AWS_ACCESS_KEY_ID: uploads.access_key_id
      - AWS_SECRET_ACCESS_KEY: uploads.secret_access_key
```

A Service and the bucket it links have to be in the same place: on the same Server, or in the same Cloud account and region. A plan refuses a Service on a Server that links a bucket on AWS, and a Service on AWS that links a bucket on a Server. The refusal names the Service and the variable, for example `web.env.S3_BUCKET`.

---

## What each Output is

A bucket hands out the same six Outputs on every Deploy target. There is no `url`.

| Output | On AWS | On a Server |
|---|---|---|
| `name` | the bucket's real name, which Cloudgate makes | the same |
| `region` | the Environment's region | `us-east-1` |
| `endpoint` | `https://s3.<region>.amazonaws.com` | the bucket's Domain while it has one, else its internal URL |
| `access_key_id`, `secret_access_key` | **no value** | the bucket's key |
| `path_style` | `"false"` | `"true"` |

Each value reaches the Service at its deploy, the way its other variables do. On AWS each one is an SSM `SecureString` parameter that the task reads when it starts. It is never in the task definition.

## Access on AWS: the task's own role

On AWS a bucket has no key. Each cloud Service runs as its own task role. A Service that links any Output of a bucket gets these permissions on that bucket:

- get, put and delete its objects,
- list its objects,
- upload in parts (multipart uploads).

It gets nothing on the bucket's settings, such as its policy, CORS or versioning, and it cannot delete the bucket. It gets nothing on a bucket it does not link. When you remove the last link to a bucket, the next deploy takes that access away.

A variable linked to `access_key_id` or `secret_access_key` is **left unset** on AWS. It is not set to an empty value. With no key variables, the AWS SDK's default credential chain uses the task role, so the same code works on a Server and on AWS. Every plan says this for each such variable: "on AWS the task's role gives access".

**An app that passes keys to its S3 client by hand breaks on AWS.** For example, `new S3Client({ credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, … } })` gets an undefined key. Let the SDK find its credentials by itself: leave `credentials` out, or pass it only when the variables are set. The plan warns about this too.

## Presigned URLs on AWS

A presigned URL is signed with the credentials of whoever made it. On AWS these are the task role's credentials, which are short-lived: AWS replaces them every few hours. A presigned URL **stops working when the credentials that signed it expire**, even if the expiry you gave the URL is later. So make a presigned URL when it is about to be used, not long in advance, and do not count on one lasting more than an hour.

On a Server, a presigned URL is signed with the bucket's key, which does not expire. It works only through the bucket's Domain, because a browser cannot reach the internal URL.
