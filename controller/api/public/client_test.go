package public

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io/ioutil"
	"net/http"
	"net/url"
	"testing"

	"github.com/golang/protobuf/proto"
	healthcheckPb "github.com/linkerd/linkerd2/controller/gen/common/healthcheck"
	pb "github.com/linkerd/linkerd2/controller/gen/public"
)

type mockTransport struct {
	responseToReturn *http.Response
	requestSent      *http.Request
	errorToReturn    error
}

func (m *mockTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	m.requestSent = req
	return m.responseToReturn, m.errorToReturn
}

func TestNewInternalClient(t *testing.T) {
	t.Run("Makes a well-formed request over the Kubernetes public API", func(t *testing.T) {
		mockTransport := &mockTransport{}
		mockTransport.responseToReturn = &http.Response{
			StatusCode: 200,
			Body:       ioutil.NopCloser(bufferedReader(t, &pb.Empty{})),
		}
		mockHttpClient := &http.Client{
			Transport: mockTransport,
		}

		apiURL := &url.URL{
			Scheme: "http",
			Host:   "some-hostname",
			Path:   "/",
		}
		client, err := newClient(apiURL, mockHttpClient, "linkerd")
		if err != nil {
			t.Fatalf("Unexpected error: %v", err)
		}

		_, err = client.Version(context.Background(), &pb.Empty{})
		if err != nil {
			t.Fatalf("Unexpected error: %v", err)
		}

		expectedUrlRequested := "http://some-hostname/api/v1/Version"
		actualUrlRequested := mockTransport.requestSent.URL.String()
		if actualUrlRequested != expectedUrlRequested {
			t.Fatalf("Expected request to URL [%v], but got [%v]", expectedUrlRequested, actualUrlRequested)
		}
	})
}

func TestFromByteStreamToProtocolBuffers(t *testing.T) {
	t.Run("Correctly marshalls an valid object", func(t *testing.T) {
		versionInfo := pb.VersionInfo{
			GoVersion:      "1.9.1",
			BuildDate:      "2017.11.17",
			ReleaseVersion: "1.2.3",
		}

		var protobufMessageToBeFilledWithData pb.VersionInfo
		reader := bufferedReader(t, &versionInfo)

		err := fromByteStreamToProtocolBuffers(reader, &protobufMessageToBeFilledWithData)
		if err != nil {
			t.Fatalf("Unexpected error: %v", err)
		}

		if !proto.Equal(&protobufMessageToBeFilledWithData, &versionInfo) {
			t.Fatalf("mismatch, %+v != %+v", protobufMessageToBeFilledWithData, versionInfo)
		}
	})

	t.Run("Correctly marshalls a large byte array", func(t *testing.T) {
		rows := make([]*pb.StatTable_PodGroup_Row, 0)

		numberOfResourcesInMessage := 400
		for i := 0; i < numberOfResourcesInMessage; i++ {
			rows = append(rows, &pb.StatTable_PodGroup_Row{
				Resource: &pb.Resource{
					Namespace: "default",
					Name:      fmt.Sprintf("deployment%d", i),
					Type:      "deployment",
				},
			})
		}

		msg := pb.StatSummaryResponse{
			Response: &pb.StatSummaryResponse_Ok_{
				Ok: &pb.StatSummaryResponse_Ok{
					StatTables: []*pb.StatTable{
						&pb.StatTable{
							Table: &pb.StatTable_PodGroup_{
								PodGroup: &pb.StatTable_PodGroup{
									Rows: rows,
								},
							},
						},
					},
				},
			},
		}

		reader := bufferedReader(t, &msg)

		protobufMessageToBeFilledWithData := &pb.StatSummaryResponse{}
		err := fromByteStreamToProtocolBuffers(reader, protobufMessageToBeFilledWithData)
		if err != nil {
			t.Fatalf("Unexpected error: %v", err)
		}
	})

	t.Run("When byte array contains error, treats stream as regular protobuf object", func(t *testing.T) {
		apiError := pb.ApiError{Error: "an error occurred"}

		var protobufMessageToBeFilledWithData pb.ApiError
		reader := bufferedReader(t, &apiError)
		err := fromByteStreamToProtocolBuffers(reader, &protobufMessageToBeFilledWithData)
		if err != nil {
			t.Fatalf("Unexpected error: %v", err)
		}

		expectedErrorMessage := apiError.Error
		actualErrorMessage := protobufMessageToBeFilledWithData.Error
		if actualErrorMessage != expectedErrorMessage {
			t.Fatalf("Expected object to contain message [%s], but got [%s]", expectedErrorMessage, actualErrorMessage)
		}
	})

	t.Run("Returns error if byte stream contains wrong object", func(t *testing.T) {
		versionInfo := &pb.VersionInfo{
			GoVersion:      "1.9.1",
			BuildDate:      "2017.11.17",
			ReleaseVersion: "1.2.3",
		}

		reader := bufferedReader(t, versionInfo)

		protobufMessageToBeFilledWithData := &pb.StatSummaryResponse{}
		err := fromByteStreamToProtocolBuffers(reader, protobufMessageToBeFilledWithData)
		if err == nil {
			t.Fatal("Expecting error, got nothing")
		}
	})
}

func TestSelfCheck(t *testing.T) {
	t.Run("Returns failed status check if namespace does not exist", func(t *testing.T) {
		mockTransport := &mockTransport{}
		mockTransport.responseToReturn = &http.Response{
			StatusCode: 404,
		}
		mockHttpClient := &http.Client{
			Transport: mockTransport,
		}

		apiURL := &url.URL{
			Scheme: "http",
			Host:   "some-hostname",
			Path:   "/",
		}
		client, err := newClient(apiURL, mockHttpClient, "testnamespace")
		if err != nil {
			t.Fatalf("Unexpected error: %v", err)
		}

		rsp, err := client.SelfCheck(context.Background(), &healthcheckPb.SelfCheckRequest{})
		if err != nil {
			t.Fatalf("Unexpected error: %v", err)
		}

		expectedUrlRequested := "http://some-hostname/api/v1/namespaces/testnamespace"
		actualUrlRequested := mockTransport.requestSent.URL.String()
		if actualUrlRequested != expectedUrlRequested {
			t.Fatalf("Expected request to URL [%v], but got [%v]", expectedUrlRequested, actualUrlRequested)
		}

		if len(rsp.Results) != 1 {
			t.Fatalf("Expected one check result, got %v", rsp.Results)
		}

		expectedCheckResult := &healthcheckPb.CheckResult{
			SubsystemName:         "namespace",
			CheckDescription:      "control plane namespace exists",
			Status:                healthcheckPb.CheckStatus_FAIL,
			FriendlyMessageToUser: "The \"testnamespace\" namespace does not exist",
		}

		if !proto.Equal(rsp.Results[0], expectedCheckResult) {
			t.Fatalf("Expected check result to be [%v], but got [%v]", expectedCheckResult, rsp.Results[0])
		}
	})
}

func bufferedReader(t *testing.T, msg proto.Message) *bufio.Reader {
	msgBytes, err := proto.Marshal(msg)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	payload, err := serializeAsPayload(msgBytes)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	return bufio.NewReader(bytes.NewReader(payload))
}
