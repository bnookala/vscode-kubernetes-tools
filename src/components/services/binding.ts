'use strict';

import { host } from '../../host';
import * as cli from '../../shell';
import * as yamljs from 'yamljs';
import { create as kubectlCreate, Kubectl } from '../../kubectl';
import { fs } from '../../fs';
import { shell } from '../../shell';
import { QuickPickOptions } from 'vscode';
import { removeServiceBinding, writeSecretData, isBindingAdded, pickChartAsync, writeUsageToClipboard, loadChartValues } from './util';

export enum ServiceType {
    serviceEnv = "serviceEnv",
    serviceCatalogEnv = "serviceCatalogEnv"
}

interface Service {
    name: string;
    namespace: string;
}

interface ServiceInstance {
    name: string;
    namespace: string;
    class: string;
    plan: string;
    status: string;
}

interface ServiceInstanceMap {
    [name: string]: ServiceInstance;
}

function depCallback(): void {}

const kubectl = kubectlCreate(host, fs, shell, depCallback);

export const ServiceInstanceNames: string[] = [];
export const ServiceInstanceArray: ServiceInstance[] = [];
export const ServiceInstanceMap: ServiceInstanceMap = {};

/**
 * Add a Kubernetes Service.
 */
export async function addService () {
    const chartYaml = await loadChartValues();

    const serviceResult = await kubectl.invokeAsync('get svc -o json');
    if (serviceResult.code === -1) {
        return;
    }

    const servicesJson = JSON.parse(serviceResult.stdout);
    if (servicesJson.items.length === 0) {
        host.showInformationMessage("No services found in current namespace");
        return;
    }

    const services = [];
    const serviceNames = [];

    for (const service of servicesJson.items) {
        const metadata = service.metadata;
        services.push({
            name: metadata.name,
            namespace: metadata.namespace
        });
        serviceNames.push(metadata.name);
    }

    const selectedService = await host.showQuickPick(
        serviceNames,
        { placeHolder: "Select a Kubernetes service to bind" }
    );

    if (selectedService === "") {
        return;
    }

    // filter on the name.
    const serviceObj = services.filter((service) => { return service.name === selectedService; })[0];
    const dnsName = `${serviceObj.name}.${serviceObj.namespace}.svc.cluster.local`;

    if (isBindingAdded(ServiceType.serviceEnv, serviceObj.name, chartYaml.yaml)) {
        return;
    }

    await writeSecretData(ServiceType.serviceEnv, serviceObj.name, dnsName, chartYaml);
    await writeUsageToClipboard(ServiceType.serviceEnv, serviceObj.name, serviceObj.name);
    host.showInformationMessage("Wrote service info to your clipboard");
}

export async function removeService () {
    await removeServiceBinding(ServiceType.serviceEnv);
}

/**
 * Creates a binding for the application to the selected service.
 * Modifies the values.yaml file to retain information about available environment variables.
 * Drops an information blurb on the clipboard for service catalog usage information.
 */
export async function addExternalService () {
    const chartYaml = await loadChartValues();

    if (ServiceInstanceNames.length === 0 && Object.keys(ServiceInstanceMap).length === 0) {
        let serviceInstances = await getServiceInstances();
    }

    const serviceToBind = await host.showQuickPick(ServiceInstanceNames, {
        placeHolder: "Pick an External Service to add to the selected application",
    });

    const binding = await createOrGetServiceBinding(serviceToBind);
    // could not create a new or get a service binding - not a case we should encounter.
    if (!binding) {
        return;
    }

    // check to see if we've already added this service binding.
    if (isBindingAdded(ServiceType.serviceCatalogEnv, binding, chartYaml.yaml)) {
        return;
    }

    const secretData = await getSecretData(binding);
    const secretKeys = Object.keys(secretData);
    await writeSecretData(ServiceType.serviceCatalogEnv, binding, secretKeys, chartYaml);
    await writeUsageToClipboard(ServiceType.serviceCatalogEnv, binding, secretKeys);

    host.showInformationMessage(`Bound the application to External Service "${serviceToBind}"`);
}

/**
 * Removes a binding from the values.yaml file. Does not delete the binding from the service catalog
 * due to concerns about other applications having bound it.
 */
export async function removeExternalService () {
    await removeServiceBinding(ServiceType.serviceCatalogEnv);
}

/**
 * Retrieves deployed secrets.
 * @param secretName The secret name deployed by service catalog.
 * @returns The secret data
 */
async function getSecretData (secretName): Promise<Object> {
    let secretResults;
    try {
        secretResults = await kubectl.invokeAsync(`get secret ${secretName} -o json`);
    } catch (e) {
        host.showErrorMessage(`Could not find the External Service secret ${secretName} on the cluster`);
        return;
    }

    if (secretResults.code !== 0) {
        host.showErrorMessage(`Could not get External Service ${secretName} on the cluster`);
        return;
    }

    const secretResultsJson = JSON.parse(secretResults.stdout);
    return secretResultsJson.data;
}

/**
 * Binds an external service by creating a secret containing consumable binding information.
 * @param serviceName The service to create a binding for.
 */
async function createOrGetServiceBinding (serviceName: string): Promise<string|null> {
    let results;
    try {
        results = await cli.shell.execCore(`svcat bind ${serviceName}`, '');
    } catch (e) {
        host.showErrorMessage(`Error binding to External Service "${serviceName}"`);
        return;
    }

    if (results.code !== 0) {
        // binding exists - consume it.
        if (results.stderr.indexOf("already exists")) {
            return serviceName;
        }

        host.showErrorMessage(`Could not bind to External Service "${serviceName}"`);
        return null;
    }

    return serviceName;
}

/**
 * Gets available service instances deployed to your cluster.
 * @returns A list of ServiceInstance objects.
 */
export async function getServiceInstances (): Promise<ServiceInstance[]> {
    // If we've already got service instances, just return those.
    // TODO: figure out how we're gonna add new instances as they come up.
    if (ServiceInstanceNames.length !== 0 && Object.keys(ServiceInstanceMap).length !== 0) {
        return ServiceInstanceArray;
    }

    let results;
    try {
        results = await cli.shell.execCore(`svcat get instances`, '');
    } catch (e) {
        host.showErrorMessage(`Error retrieving Service Instances`);
        return;
    }

    if (results.code !== 0) {
        host.showErrorMessage(`Error retrieving Service Instances`);
        return;
    }

    return cleanUpInstanceResults(results.stdout as string);
}

function cleanUpInstanceResults (results: string): ServiceInstance[] {
    // Remove headers + empty lines.
    const splitResults = results.split('\n').slice(2).filter((s) => s.length != 0);
    const cleanedResults: ServiceInstance[] = [];

    // Build up ServiceInstance objects.
    for (let line of splitResults) {
        const filtered = line.split(' ').filter((s) => s.length != 0);
        const serviceInstance: ServiceInstance = {
            name: filtered[0],
            namespace: filtered[1],
            class: filtered[2],
            plan: filtered[3],
            status: filtered[4]
        };

        // Service instance name -> service instance map.
        ServiceInstanceMap[serviceInstance.name] = serviceInstance;

        // All available service instance names.
        ServiceInstanceNames.push(serviceInstance.name);

        ServiceInstanceArray.push(serviceInstance);
        cleanedResults.push(serviceInstance);
    }

    return cleanedResults;
}