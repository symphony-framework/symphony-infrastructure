import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Duration } from 'aws-cdk-lib';

import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager'

import * as alb from "aws-cdk-lib/aws-elasticloadbalancingv2"
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';

import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';

import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';

import * as dotenv from "dotenv"
dotenv.config();

const REGION = process.env.AWS_REGION || 'us-east-1';

const API = process.env.API_SUBDOMAIN || "api subdomain env undefined"
const DOMAIN = process.env.DOMAIN || "domain env undefined";

const INIT_METADATA_SCHEMA_IMAGE = process.env.SYM_INIT_METADATA_IMAGE || "no init postgres img env"

const WS_IMAGE = process.env.SYM_WS_IMAGE || 'ojodetoro/symphony-ws';
const WS_PORT = process.env.SYM_WS_PORT || '8001';

const DASHBOARD_IMAGE = process.env.SYM_DASHBOARD_IMAGE || "no dashboard image";
const DASHBOARD_PORT = process.env.SYM_DASHBOARD_PORT || '8000';
const DASHBOARD_SERVICE = process.env.SYM_DASHBOARD_SERVICE_NAME || "no dashboard service name";
const DASHBOARD_CLUSTER = process.env.SYM_DASHBOARD_CLUSTER_NAME || "no dashboard cluster name"

const metadataStorageDbname = process.env.SYM_METADATA_DB_NAME || "no metadata db nam env";

const project = process.env.PROJECT ||  "SymphonyDefault";

class SymAutoCoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create a new VPC - w/ sensible cdk defaults
    const vpc = new ec2.Vpc(this, project + 'Vpc', {
      maxAzs: 2,
    });

    // reference a hosted zone
    const hostedZone = route53.HostedZone.fromLookup(this, `${DOMAIN}-hosted-zone`, {
      domainName: DOMAIN,
    });

    // Create a certificate for the domain. Ownership of the domain will be validated via DNS records created for us in the Hosted Zone.
    const certificate = new acm.Certificate(this, `${API}.${DOMAIN}-cert`, {
      domainName: `${API}.${DOMAIN}`,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // Create a new ALB
    const loadBalancer = new alb.ApplicationLoadBalancer(this, project + 'SecureALB', {
      vpc,
      internetFacing: true,
      securityGroup: new ec2.SecurityGroup(this, project + "SecureALB-SG", {vpc})
    });
    
    // Route traffic hitting api.DOMAIN to the Application Load Balancer
    new route53.ARecord(this, `${API}.${DOMAIN}-zone`, {
      recordName: API,
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(loadBalancer)),
      ttl: Duration.minutes(5)
    });

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////// Core infrastrucutre: wsServer, Datastores, Redis messaging service ///////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    // cluster for our custom WS
    const pubSubCluster = new ecs.Cluster(this, project + 'PubSub', {
      vpc,
    });

    // pubSub fargate task definition
    const pubSubTask = new ecs.FargateTaskDefinition(this, project + 'PubSubTask', {
      memoryLimitMiB: 4096,
      cpu: 1024,
      executionRole: new iam.Role(this, project + 'TaskExecutionRole', {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      })
    })

    // pubsub security group
    const pubSubSG = new ec2.SecurityGroup(this, project + 'PubSub-SG', {
      vpc,
      allowAllOutbound: true,
    });

    const pubSubService = new ecs.FargateService(this, project + 'PubSubService', {
      cluster: pubSubCluster,
      taskDefinition: pubSubTask,
      desiredCount: 5,
      securityGroups: [
        pubSubSG
      ],
    })

    const metadataStorageSG = new ec2.SecurityGroup(this, project + 'MetadataStorage-SG', {
      vpc,
      allowAllOutbound: true,
    });

    // Create an RDS database
    const metadataStorage = new rds.DatabaseInstance(this, project + 'Metadata', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_12_7,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M6G, ec2.InstanceSize.XLARGE),
      vpc,
      allocatedStorage: 20,
      securityGroups: [
        metadataStorageSG
      ],
      credentials: rds.Credentials.fromGeneratedSecret('postgres'),
      databaseName: metadataStorageDbname,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    
    // Create an S3 bucket
    const persitentStorage = new s3.Bucket(this, project + 'Peristence', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // allow ecs tasks to read and write to the new s3 bucket
    persitentStorage.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject'],
      principals: [new iam.ServicePrincipal('ecs-tasks.amazonaws.com')],
      resources: [`${persitentStorage.bucketArn}/*`]
    }))

    // Create a DynamoDB table
    const docIpsTable = new dynamodb.Table(this, project + 'DocumentLocations', {
      tableName: project + 'DocumentStateLocations',
      partitionKey: {name: 'id', type: dynamodb.AttributeType.STRING},
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      readCapacity: 5,
      writeCapacity: 5
    })

    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'Subnet group for Redis cluster',
      subnetIds: vpc.privateSubnets.map(subnet => subnet.subnetId),
    });

    const redisSG = new ec2.SecurityGroup(this, project + 'Redis-SG', {
      vpc,
      allowAllOutbound: true,
    })

    const redis = new elasticache.CfnReplicationGroup(this, project + 'ReplicationGroup', {
      replicationGroupDescription: project + ' elasticache replication group',
      engine: 'redis',
      cacheNodeType: 'cache.t3.medium',
      numNodeGroups: 1,
      replicasPerNodeGroup: 2,
      automaticFailoverEnabled: true,
      multiAzEnabled: true,
      cacheSubnetGroupName: redisSubnetGroup.ref,
      securityGroupIds: [redisSG.securityGroupId],
    });

    // get rds connection info
    const metadataStorageHost = metadataStorage.dbInstanceEndpointAddress;
    const metadataStoragePort = metadataStorage.dbInstanceEndpointPort;

    const metadataStorageSecret = metadataStorage.secret!;
    const metadataStorageUsername = metadataStorageSecret.secretValueFromJson('username').unsafeUnwrap().toString();
    const metadataStoragePassword = metadataStorageSecret.secretValueFromJson('password').unsafeUnwrap().toString();

    // define the metadata db url
    const prismaConnectionString = `postgresql://${metadataStorageUsername}:${metadataStoragePassword}@${metadataStorageHost}:${metadataStoragePort}/${metadataStorageDbname}?schema=public`;
    
    // container for pubsub task
    const pubSubContainer = pubSubTask.addContainer(project + "PubSubContainer", {
      image: ecs.ContainerImage.fromRegistry(WS_IMAGE),
      environment: {
        'PORT': WS_PORT,
        'REGION': REGION,
        'CLUSTER': pubSubCluster.clusterName,
        'DASHBOARD_PORT': DASHBOARD_PORT,
        'DASHBOARD_SERVICE': DASHBOARD_SERVICE,
        'DASHBOARD_CLUSTER': DASHBOARD_CLUSTER,

        'REDIS_HOST': redis.attrPrimaryEndPointAddress,
        'REDIS_PORT': '6379',
        'DYNAMO_TABLE': docIpsTable.tableName,
        'BUCKET': persitentStorage.bucketName,
        'METADATA_DB_URL': prismaConnectionString,
      },
      logging: new ecs.AwsLogDriver({
        streamPrefix: project + 'PubSub',
        logRetention: logs.RetentionDays.ONE_DAY,
      })
    })

    pubSubContainer.addPortMappings({
      containerPort: +WS_PORT,
      protocol: ecs.Protocol.TCP,
    })

    // make new target group for pubSubService
    const pubSubTargetGroup = new alb.ApplicationTargetGroup(this, 'PubSubTargetGroup', {
      vpc,
      protocol: alb.ApplicationProtocol.HTTP,
      targetType: alb.TargetType.IP,
      port: Number(WS_PORT),
      deregistrationDelay: Duration.minutes(0),
      loadBalancingAlgorithmType: alb.TargetGroupLoadBalancingAlgorithmType.LEAST_OUTSTANDING_REQUESTS,
      healthCheck: {
        interval: Duration.seconds(10),
        path: "/"
      }
      // stickinessCookieDuration: Duration.hours(1.5), 
    });

    // add pubSubService to target group
    pubSubTargetGroup.addTarget(pubSubService);

    // add http listener to load balancer, w/ default redirect action to https
    loadBalancer.addListener('httpListener', {
      port: 80,
      defaultAction: alb.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      })
    })
    
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////// CREATE DASHBOARD API SERVICE ///////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    const dashboardCluster = new ecs.Cluster(this, project + 'Dashboard', {
      vpc,
      clusterName: DASHBOARD_CLUSTER,
    });

    const dashboardSG = new ec2.SecurityGroup(this, project + 'Dashboard-SG', {
      vpc,
      allowAllOutbound: true
    })

    const dashboardTask = new ecs.FargateTaskDefinition(this, project + 'DashboardTask', {
      memoryLimitMiB: 512,
      cpu: 256,
      executionRole: new iam.Role(this, project + 'DashboardTaskExecutionRole', {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      })
    })

    const dashboardService = new ecs.FargateService(this, project + 'DashboardService', {
      cluster: dashboardCluster,
      taskDefinition: dashboardTask,
      desiredCount: 1,
      securityGroups: [dashboardSG],
      serviceName: DASHBOARD_SERVICE,
    })

    const dashboardContainer = dashboardTask.addContainer(project + 'DashboardContainer', {
      image: ecs.ContainerImage.fromRegistry(DASHBOARD_IMAGE),
      environment: {
        'PORT': DASHBOARD_PORT,
        'REGION': REGION,
        'CLUSTER': DASHBOARD_CLUSTER,
        'WS_CLUSTER': pubSubCluster.clusterName,
        'WS_SERVICE': pubSubService.serviceName,
        'WS_PORT': WS_PORT,
        'METADATA_DB_URL': prismaConnectionString,
        
        'BUCKET': persitentStorage.bucketName,
      },
      logging: new ecs.AwsLogDriver({
        streamPrefix: project + 'DashboardLogs',
        logRetention: logs.RetentionDays.ONE_DAY,
      })
    });

    dashboardContainer.addPortMappings({
      containerPort: +DASHBOARD_PORT,
      protocol: ecs.Protocol.TCP,
    })

    const dashboardTG = new alb.ApplicationTargetGroup(this, project + 'Dashboard-TG', {
      vpc,
      protocol: alb.ApplicationProtocol.HTTP,
      targetType: alb.TargetType.IP,
      port: +DASHBOARD_PORT,
      deregistrationDelay: Duration.minutes(0)
    })

    dashboardTG.addTarget(dashboardService);

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////// ADD RULES TO ALB LISTENER ///////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    // add https listener to load balancer, setting the pubSubService Target group as default
    const httpsListener = loadBalancer.addListener('httpsListener', {
      port: 443,
      certificates: [acm.Certificate.fromCertificateArn(this, `${API}.${DOMAIN}-` + 'Certificate', certificate.certificateArn)],
      defaultAction: alb.ListenerAction.forward([pubSubTargetGroup]),
    })


    httpsListener.addAction('Dashboard API', {
      priority: 1,
      conditions: [
        alb.ListenerCondition.pathPatterns(['/api/*']),
      ],
      action: alb.ListenerAction.forward([dashboardTG])
    });

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////    
    /////////////////////////////////////// CONFIGURE INBOUND SECURITY GROUP RULES ///////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    // inbound rule for ws servers
    pubSubService.connections.allowFrom(loadBalancer.connections, ec2.Port.tcp(+WS_PORT), "Allow ALB traffic to ws servers");
    pubSubService.connections.allowFrom(pubSubService.connections, ec2.Port.tcp(+WS_PORT), "Allow traffic between ws servers");
    pubSubService.connections.allowFrom(dashboardService.connections, ec2.Port.tcp(+WS_PORT), "Allow dashboard api server to make webhook request to ws servers");    

    // inbound rules for dashboard api server
    dashboardService.connections.allowFrom(loadBalancer.connections, ec2.Port.tcp(+DASHBOARD_PORT), "Allow ALB traffic");
    dashboardService.connections.allowFrom(pubSubService.connections, ec2.Port.tcp(+DASHBOARD_PORT), "allow inbound from ws servers")
    
    // allow custom WS servers to read and write to persistence
    persitentStorage.grantReadWrite(pubSubService.taskDefinition.taskRole);
    // allow dashboard for viewing room state
    persitentStorage.grantReadWrite(dashboardService.taskDefinition.taskRole);

    // allow custom WS servers to read and write to ip address storage
    docIpsTable.grantReadWriteData(pubSubService.taskDefinition.taskRole);

     // inbound rules for metadataStorage
    metadataStorage.connections.allowFrom(pubSubService.connections, ec2.Port.tcp(5432), "Allow ws server to access metadata storage");
    metadataStorage.connections.allowFrom(dashboardService.connections, ec2.Port.tcp(5432), "Allow dashboard api server to open connection to metadata storage");

    // Allow ws servers to access redis cluster
    redisSG.addIngressRule(pubSubSG, ec2.Port.tcp(6379));

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////// ALLOW ecs.ListTasks && ecs.DescribeTasks ///////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    // allow servers to list tasks - to query aws api for ip retrieval of servers
    const ecsListTaskPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [`ecs:ListTasks`],
      resources: ['*'],
    })

    const describeTasksPolicy = new iam.PolicyStatement({
      actions: ['ecs:DescribeTasks'],
      resources: ['*'],
    });

    pubSubTask.taskRole.addToPrincipalPolicy(ecsListTaskPolicy);
    pubSubTask.taskRole.addToPrincipalPolicy(describeTasksPolicy)

    dashboardTask.taskRole.addToPrincipalPolicy(ecsListTaskPolicy)
    dashboardTask.taskRole.addToPrincipalPolicy(describeTasksPolicy)
    

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////// INITIALIZE RDS SCHEMA CUSTOM AWS RESOURCE ///////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    const initRdsSG = new ec2.SecurityGroup(this, 'InitRds-SG', {
      allowAllOutbound: true,
      vpc,
    })

    const initRdsTask = new ecs.FargateTaskDefinition(this, 'InitRdsSchema', {
      memoryLimitMiB: 512,
      cpu: 256,
      executionRole: new iam.Role(this, project + 'InitRdsTask', {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      })
    })

    const initRdsContainer = initRdsTask.addContainer('InitRdsContainer', {
      image: ecs.ContainerImage.fromRegistry(INIT_METADATA_SCHEMA_IMAGE),
      environment: {
        'METADATA_DB_URL': prismaConnectionString,
      },
      logging: new ecs.AwsLogDriver({
        streamPrefix: project + 'InitRds',
        logRetention: logs.RetentionDays.ONE_DAY,
      })
    });

    initRdsContainer.addPortMappings({containerPort: 8080});
    
    new cr.AwsCustomResource(this, 'InitRdsOneTimeTask', {
      onCreate: {
        service: "ECS",
        action: "runTask",
        parameters: {
          cluster: pubSubCluster.clusterArn,
          launchType: "FARGATE",
          taskDefinition: initRdsTask.taskDefinitionArn,
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: vpc.privateSubnets.map(subnet => subnet.subnetId),
              assignPublicIp: "ENABLED",
              securityGroups: [initRdsSG.securityGroupId]
            },
          }
        },
        physicalResourceId: cr.PhysicalResourceId.of('InitRdsOneTimeTask')
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'ecs:RunTask',
            'ecs:DescribeTasks',
            'ecs:StopTask',
            'ec2:CreateNetworkInterface',
            'ec2:DescribeNetworkInterfaces',
            'ec2:DeleteNetworkInterface',
            'rds:DescribeDBInstances',
            'iam:PassRole',
          ],
          resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
        })
      ])
    });

    metadataStorageSG.addIngressRule(initRdsSG, ec2.Port.tcp(5432), "Allow init rds container to connect to metadata rds db instance")
  
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////// Auto-scale Configuration ///////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    // auto-scale configuration
    const scalePubSub = pubSubService.autoScaleTaskCount({minCapacity: 5, maxCapacity: 100});

    scalePubSub.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 50,
      scaleInCooldown: Duration.seconds(15),
      scaleOutCooldown: Duration.seconds(300),
    });

    scalePubSub.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 50,
      scaleInCooldown: Duration.seconds(30),
      scaleOutCooldown: Duration.minutes(1),
    });

    // Configure auto-scaling for read capacity
    const readScaling = docIpsTable.autoScaleReadCapacity({
      minCapacity: 5,
      maxCapacity: 100,
    });

    readScaling.scaleOnUtilization({
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.minutes(2),
      scaleOutCooldown: cdk.Duration.minutes(5),
    });

    // Configure auto-scaling for write capacity
    const writeScaling = docIpsTable.autoScaleWriteCapacity({
      minCapacity: 5,
      maxCapacity: 100,
    });

    writeScaling.scaleOnUtilization({
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.minutes(2),
      scaleOutCooldown: cdk.Duration.minutes(5),
    });

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////// Cleanup function to remove server IP from dynamo table on task failure ///////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    const cleanupRole = new iam.Role(this, project + 'WsCleanupRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
    });

    cleanupRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:UpdateItem', 'dynamodb:Scan', `dynamodb:DeleteItem`],
      resources: [docIpsTable.tableArn]
    }));

    cleanupRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: ['arn:aws:logs:*:*:*']
    }))

    const cleanupFunction = new lambda.Function(this, project + 'WsFailCleanup', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'cleanup.handler',
      code: lambda.Code.fromAsset('lambda'),
      role: cleanupRole,
      environment: {
        TABLE: docIpsTable.tableName,
        REGION: this.region,
      },
      logRetention: logs.RetentionDays.ONE_DAY,
      timeout: Duration.minutes(10),
      memorySize: 256,
    })

    const eventPattern = {
      source: ['aws.ecs'],
      detailType: ['ECS Task State Change'],
      detail: {
        group: [`service:${pubSubService.serviceName}`],
        lastStatus: ["STOPPED"],
        stoppedReason: [{
          "anything-but": {
            prefix: "Scaling activity initiated by (deployment"
          }
        }],
      },
    }

    new events.Rule(this, project + 'WsFailureCleanupRule', {
      eventPattern,
      targets: [new targets.LambdaFunction(cleanupFunction)],
      description: "Invoke cleanup lambda to remove ip address from dynamodb on task failure"
    });
  }
}

export default SymAutoCoreStack;
